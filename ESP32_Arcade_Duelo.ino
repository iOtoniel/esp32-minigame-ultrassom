/*
  ESP32 ARCADE - DUELO DE GOLEIROS (2 x HC-SR04)

  Sensor AZUL (embaixo na tela): TRIG GPIO5,  ECHO GPIO18
  Sensor VERMELHO (em cima):    TRIG GPIO25, ECHO GPIO26

  Ambos HC-SR04: VCC em 5 V, GND comum.
  CADA pino ECHO requer divisor resistivo 5 V -> ~3,3 V:
       ECHO --[1 kOhm]--+-- GPIO ECHO
                         |
                      [2 kOhm]
                         |
                        GND

  Bibliotecas:
   - WiFi.h, WebServer.h, LittleFS.h (pacote ESP32 Arduino)
   - WebSockets, de Markus Sattler / Links2004 (instalar na IDE)

  O firmware possui um uploader LittleFS integrado: depois de gravar o .ino,
  conecte-se ao Wi-Fi ESP32-Duelo / senha esp32duelo e abra
  http://192.168.4.1/upload . Envie os 4 arquivos da pasta data.
  Depois acesse http://192.168.4.1

  Modo rapido: disparos alternados a cada 8 ms (alvo: 16 ms por jogador).
  Cadencia experimental; ajuste MODO_RAPIDO em SensorUltrassonico.h se necessario.
  ECHO por interrupcao; TRIG por timer. Sem delay(), delayMicroseconds() ou pulseIn().
*/
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <LittleFS.h>
#include <math.h>
#include <esp_timer.h>
#include "SensorUltrassonico.h"

static const uint8_t TRIG[2] = {5, 25};
static const uint8_t ECHO[2] = {18, 26};
static const char* AP_NOME = "ESP32-Duelo";
static const char* AP_SENHA = "esp32duelo";

WebServer servidor(80);
WebSocketsServer websocket(81);

Sensor sensores[2];
CapturaEco capturas[2];
portMUX_TYPE muxEco = portMUX_INITIALIZER_UNLOCKED;
uint32_t ultimoDisparo = 0;
uint32_t ultimoLog = 0;
uint32_t sequencia = 0;
uint8_t proximoSensor = 0;
esp_timer_handle_t timerTrig = nullptr;
volatile int8_t triggerAtivo = -1;
File uploadArquivo;
String uploadCaminho;
bool uploadOK = false;
bool uploadFinalizado = false;
size_t uploadTotal = 0;
const char *UPLOAD_TEMP = "/.duelo-upload.tmp";

bool valido(uint8_t i) {
  return sensores[i].valido(millis());
}

void IRAM_ATTR capturarEco(void *arg) {
  CapturaEco &c = *static_cast<CapturaEco *>(arg);
  const uint32_t agora = micros();
  const bool alto = digitalRead(c.pino) == HIGH;
  portENTER_CRITICAL_ISR(&muxEco);
  if (c.ativo && uint32_t(agora - c.disparo) <= TEMPO_ECO_US) {
    if (alto && !c.subiu) {
      c.inicio = agora;
      c.subiu = true;
    } else if (!alto && c.subiu) {
      c.duracao = agora - c.inicio;
      c.concluido = agora;
      c.pronto = true;
      c.ativo = false;
    }
  }
  portEXIT_CRITICAL_ISR(&muxEco);
}

void fimTrigger(void *) {
  portENTER_CRITICAL(&muxEco);
  if (triggerAtivo >= 0) digitalWrite(TRIG[triggerAtivo], LOW);
  triggerAtivo = -1;
  portEXIT_CRITICAL(&muxEco);
}

bool iniciarSensor(uint8_t i) {
  if (!timerTrig) return false;
  // Um ECHO preso em HIGH nao e tratado como uma nova medida.
  if (digitalRead(ECHO[i]) == HIGH) return false;
  CapturaEco &c = capturas[i];
  portENTER_CRITICAL(&muxEco);
  if (triggerAtivo >= 0 || capturas[0].ativo || capturas[1].ativo) {
    portEXIT_CRITICAL(&muxEco);
    return false;
  }
  c.ativo = true;
  c.subiu = false;
  c.pronto = false;
  c.disparo = micros();
  triggerAtivo = i;
  digitalWrite(TRIG[i], HIGH);
  portEXIT_CRITICAL(&muxEco);
  if (esp_timer_start_once(timerTrig, PULSO_TRIG_US) != ESP_OK) {
    fimTrigger(nullptr);
    portENTER_CRITICAL(&muxEco);
    c.ativo = false;
    portEXIT_CRITICAL(&muxEco);
    return false;
  }
  return true;
}

bool processarEcos() {
  bool finalizou = false;
  for (uint8_t i = 0; i < 2; ++i) {
    CapturaEco &c = capturas[i];
    uint32_t duracao = 0;
    uint32_t idadeUs = 0;
    bool pronto;
    portENTER_CRITICAL(&muxEco);
    pronto = c.pronto;
    if (pronto) {
      duracao = c.duracao;
      idadeUs = micros() - c.concluido;
      c.pronto = false;
      finalizou = true;
    }
    if (c.ativo && uint32_t(micros() - c.disparo) > TEMPO_ECO_US) {
      c.ativo = false;
      finalizou = true;
    }
    portEXIT_CRITICAL(&muxEco);
    if (pronto) sensores[i].registrarEco(duracao, millis() - idadeUs / 1000UL);
  }
  return finalizou;
}

void publicar() {
  if (websocket.connectedClients() == 0) return;
  const uint32_t agora = millis();
  char dados[256];
  const int n = snprintf(dados, sizeof(dados),
    "{\"v\":1,\"seq\":%lu,\"t\":%lu,\"s\":[{\"cm\":%.2f,\"ok\":%s,\"age\":%lu,\"n\":%lu},{\"cm\":%.2f,\"ok\":%s,\"age\":%lu,\"n\":%lu}]}",
    (unsigned long)++sequencia, (unsigned long)agora,
    sensores[0].distancia, sensores[0].valido(agora) ? "true" : "false",
    (unsigned long)(sensores[0].recebido ? agora - sensores[0].ultimoEco : UINT32_MAX),
    (unsigned long)sensores[0].amostras,
    sensores[1].distancia, sensores[1].valido(agora) ? "true" : "false",
    (unsigned long)(sensores[1].recebido ? agora - sensores[1].ultimoEco : UINT32_MAX),
    (unsigned long)sensores[1].amostras);
  if (n > 0 && size_t(n) < sizeof(dados)) websocket.broadcastTXT(dados, size_t(n));
}

// Uploader local: apenas os nomes conhecidos; sem permitir caminhos arbitrarios.
static bool nomePermitido(const String &nome) {
  return nome == "index.html" || nome == "style.css" ||
         nome == "game.js" || nome == "campo.png";
}

void receberUpload() {
  HTTPUpload &up = servidor.upload();
  if (up.status == UPLOAD_FILE_START) {
    if (uploadArquivo) uploadArquivo.close();
    LittleFS.remove(UPLOAD_TEMP);
    uploadOK = false;
    uploadFinalizado = false;
    uploadTotal = 0;
    uploadCaminho = "";
    String nome = up.filename;
    nome.replace("\\", "/");
    if (nome.lastIndexOf('/') >= 0) nome = nome.substring(nome.lastIndexOf('/') + 1);
    if (!nomePermitido(nome)) return;
    uploadCaminho = "/" + nome;
    uploadArquivo = LittleFS.open(UPLOAD_TEMP, "w");
    uploadOK = (bool)uploadArquivo;
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (!uploadOK) return;
    uploadTotal += up.currentSize;
    if (uploadTotal > 600 * 1024UL || uploadArquivo.write(up.buf, up.currentSize) != up.currentSize) {
      uploadOK = false;
      uploadArquivo.close();
      LittleFS.remove(UPLOAD_TEMP);
    }
  } else if (up.status == UPLOAD_FILE_END) {
    if (uploadArquivo) uploadArquivo.close();
    if (uploadTotal == 0) uploadOK = false;
    if (uploadOK) uploadOK = LittleFS.rename(UPLOAD_TEMP, uploadCaminho);
    uploadFinalizado = uploadOK;
    if (!uploadOK) LittleFS.remove(UPLOAD_TEMP);
    Serial.printf("Upload: %s (%u bytes) %s\n", uploadCaminho.c_str(),
       (unsigned)uploadTotal, uploadOK ? "OK" : "FALHOU");
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    if (uploadArquivo) uploadArquivo.close();
    LittleFS.remove(UPLOAD_TEMP);
    uploadOK = false;
    uploadFinalizado = false;
  }
}

const char UPL_HTML[] PROGMEM = R"HTML(
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ESP32 Duelo | Arquivos</title>
<style>body{background:#0b1120;color:#fff;font:16px system-ui;margin:0;padding:20px}main{max-width:550px;margin:30px auto;background:#172033;border:1px solid #334155;border-radius:20px;padding:24px}h1{font-size:24px}p{color:#bdcde0;line-height:1.6}input{width:100%;padding:16px 0}button,a{display:inline-block;border:none;border-radius:10px;padding:12px 18px;background:#38bdf8;color:#082033;font-weight:700;text-decoration:none;cursor:pointer}a{background:#334155;color:white}#log{white-space:pre-wrap;font-size:14px;line-height:1.7}small{color:#94a3b8}</style></head>
<body><main><h1>ESP32 Duelo — Arquivos</h1><p>Selecione <strong>index.html, style.css, game.js e campo.png</strong> da pasta <code>data</code> do projeto. Eles ficam no LittleFS do ESP32.</p>
<input id="arquivos" type="file" multiple><p><button id="enviar">Enviar arquivos</button> <a href="/">Abrir jogo</a></p><div id="log" role="status"></div><small>Disponivel apenas na rede Wi-Fi local do ESP32. Nao desligue durante o envio.</small></main>
<script>
document.querySelector('#enviar').onclick=async()=>{
  const arquivos=[...document.querySelector('#arquivos').files];
  const log=document.querySelector('#log'), botao=document.querySelector('#enviar');
  if(!arquivos.length){log.textContent='Selecione os quatro arquivos.';return;}
  botao.disabled=true;log.textContent='';let falhas=0;
  for(const arq of arquivos){
    const form=new FormData();form.append('file',arq,arq.name);
    try{
      const r=await fetch('/api/upload',{method:'POST',body:form});
      if(!r.ok)throw Error(await r.text());
      log.textContent+='✓ '+arq.name+' enviado\n';
    }catch(e){falhas++;log.textContent+='✗ '+arq.name+': '+e.message+'\n';}
  }
  botao.disabled=false;
  log.textContent+=falhas?'\nReenvie os arquivos que falharam antes de abrir o jogo.':'\nConcluido. Abra o jogo.';
};
</script></body></html>
)HTML";

void servirArquivo(const char *caminho, const char *mime, bool cache = false) {
  File f = LittleFS.open(caminho, "r");
  if (!f || f.isDirectory()) {
    servidor.send(404, "text/html; charset=utf-8",
      "Arquivo ausente no LittleFS. Abra <a href='/upload'>/upload</a> para enviar os arquivos.");
    if (f) f.close();
    return;
  }
  servidor.sendHeader("Cache-Control", cache ? "public, max-age=86400" : "no-store");
  servidor.streamFile(f, mime);
  f.close();
}

void eventoWS(uint8_t client, WStype_t evento, uint8_t*, size_t) {
  if (evento == WStype_CONNECTED) Serial.printf("WS: tela conectada (%u)\n", client);
  if (evento == WStype_DISCONNECTED) Serial.printf("WS: tela desconectada (%u)\n", client);
  // A simulacao e a calibracao rodam na tela. O ESP32 apenas envia leituras.
}

void setup() {
  Serial.begin(115200);
  esp_timer_create_args_t args = {};
  args.callback = fimTrigger;
  args.name = "duelo-trig";
  if (esp_timer_create(&args, &timerTrig) != ESP_OK) {
    timerTrig = nullptr;
    Serial.println("ERRO: nao foi possivel criar timer do TRIG");
  }
  for (int i = 0; i < 2; ++i) {
    pinMode(TRIG[i], OUTPUT);
    pinMode(ECHO[i], INPUT);
    digitalWrite(TRIG[i], LOW);
    capturas[i].pino = ECHO[i];
    attachInterruptArg(ECHO[i], capturarEco, &capturas[i], CHANGE);
  }
  if (!LittleFS.begin(true)) Serial.println("ERRO: LittleFS indisponivel");
  else LittleFS.remove(UPLOAD_TEMP);
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(AP_NOME, AP_SENHA)) Serial.println("ERRO: falha na rede AP");

  servidor.on("/", HTTP_GET, []() { servirArquivo("/index.html", "text/html; charset=utf-8"); });
  servidor.on("/style.css", HTTP_GET, []() { servirArquivo("/style.css", "text/css; charset=utf-8"); });
  servidor.on("/game.js", HTTP_GET, []() { servirArquivo("/game.js", "application/javascript; charset=utf-8"); });
  servidor.on("/campo.png", HTTP_GET, []() { servirArquivo("/campo.png", "image/png", true); });
  servidor.on("/upload", HTTP_GET, []() { servidor.send_P(200, "text/html; charset=utf-8", UPL_HTML); });
  servidor.on("/api/upload", HTTP_POST, []() {
    servidor.send(uploadFinalizado ? 200 : 400, "text/plain",
      uploadFinalizado ? "OK" : "Falha no upload ou nome nao permitido");
    uploadFinalizado = false;
  }, receberUpload);
  servidor.onNotFound([]() { servidor.send(404, "text/plain", "Nao encontrado"); });
  servidor.begin();
  websocket.begin();
  websocket.onEvent(eventoWS);
  websocket.enableHeartbeat(5000, 1000, 2);

  Serial.println("\n=== ESP32 ARCADE DUELO ===");
  Serial.print("Wi-Fi: "); Serial.println(AP_NOME);
  Serial.print("Senha: "); Serial.println(AP_SENHA);
  Serial.print("Acesse: http://"); Serial.println(WiFi.softAPIP());
  Serial.println("Para instalar/atualizar os arquivos: /upload");
}

void atualizarSensores() {
  if (processarEcos()) publicar();
  const uint32_t agora = micros();
  if (uint32_t(agora - ultimoDisparo) >= INTERVALO_DISPAROS_US) {
    ultimoDisparo = agora;
    const bool iniciou = iniciarSensor(proximoSensor);
    proximoSensor ^= 1;
    if (!iniciou) publicar();
  }
}

void loop() {
  atualizarSensores();
  websocket.loop();
  atualizarSensores();
  servidor.handleClient();
  atualizarSensores();
  const uint32_t agora = millis();
  if (LOG_SENSORES && uint32_t(agora - ultimoLog) > 800) {
    ultimoLog = agora;
    for (int i=0;i<2;++i) {
      Serial.printf("Goleiro %u: ", (unsigned)(i+1));
      if (valido(i)) Serial.printf("%.1f cm", sensores[i].distancia);
      else Serial.print("SEM ECO");
      Serial.print(i ? "\n" : " | ");
    }
  }
}
