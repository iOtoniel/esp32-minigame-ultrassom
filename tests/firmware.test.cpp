#include <cassert>
#include <iostream>
#include <cstring>
#include "../ESP32_Arcade_Duelo.ino"

static uint32_t us(float cm){return uint32_t(cm/0.01715f+0.5f);}
static void reset(){
  fakeUs=0; for(int &pin:pins)pin=0;
  for(int i=0;i<2;i++){sensores[i]=Sensor();capturas[i]=CapturaEco();capturas[i].pino=ECHO[i];}
  ultimoDisparo=0; proximoSensor=0; disparos.clear();
  triggerAtivo=-1;timerFake.ativo=false;falharTimer=false;
}
static void envio(int status,const char *nome="game.js",const char *conteudo="novo"){
  auto &up=servidor.incoming;up.status=status;up.filename=nome;
  up.currentSize=strlen(conteudo);up.buf=(uint8_t*)conteudo;receberUpload();
}
static std::string arquivo(const char *nome){auto f=files.at(nome);return std::string(f->begin(),f->end());}
static void simularSensores(bool vermelho){
  reset();
  for(uint64_t t=0;t<=1000000;t+=10){
    fakeUs=t;executarTimersFake();
    for(int i=0;i<2;i++){
      auto &c=capturas[i];
      if(i==1&&!vermelho)continue;
      if(c.ativo){
        const uint32_t desde=micros()-c.disparo;
        if(!c.subiu&&desde>=200)edge(ECHO[i],HIGH,t);
        else if(c.subiu&&desde>=200+us(i?30:20))edge(ECHO[i],LOW,t);
      }
    }
    loop();
  }
}
int main(){
  setup();
  // Movimento normal aceito ja na primeira amostra, sem mediana em cascata.
  Sensor azul,vermelho;
  azul.registrarEco(us(20),0);azul.registrarEco(us(20),130);azul.registrarEco(us(20),260);
  assert(azul.registrarEco(us(22),284));assert(fabs(azul.distancia-22)<0.05);
  assert(!azul.registrarEco(us(60),308));assert(fabs(azul.distancia-22)<0.05);
  assert(azul.registrarEco(us(24),332));assert(fabs(azul.distancia-24)<0.05);
  assert(!azul.registrarEco(us(45),356));
  assert(azul.registrarEco(us(46),380));assert(fabs(azul.distancia-46)<0.05);
  vermelho.registrarEco(us(30),390);assert(fabs(vermelho.distancia-30)<0.05);
  assert(!azul.registrarEco(0,400));assert(!azul.registrarEco(us(2),400));
  assert(!azul.registrarEco(us(66),400));assert(azul.ultimoEco==380);
  assert(azul.valido(879));assert(!azul.valido(880));
  azul.registrarEco(us(10),1000);assert(!azul.haPendente);assert(fabs(azul.distancia-10)<.05);
  Sensor wrap;wrap.registrarEco(us(15),UINT32_MAX-100);assert(wrap.valido(100));assert(!wrap.valido(500));
  std::cout<<"OK primeira amostra imediata, salto isolado rejeitado, salto real confirmado, independencia e rollover\n";

  reset();assert(iniciarSensor(0));assert(fakeUs==0);assert(pins[5]==HIGH);
  assert(!iniciarSensor(1)); // Nao sobrepoe transmissores.
  fakeUs=PULSO_TRIG_US-1;executarTimersFake();assert(pins[5]==HIGH);
  fakeUs=PULSO_TRIG_US;executarTimersFake();assert(pins[5]==LOW);
  edge(18,HIGH,100);edge(18,LOW,100+us(20));assert(processarEcos());
  assert(valido(0));assert(!valido(1));assert(fabs(sensores[0].distancia-20)<.05);
  assert(!processarEcos());
  reset();assert(iniciarSensor(1));fakeUs=5501;assert(processarEcos());assert(!capturas[1].ativo);
  edge(26,HIGH,5600);edge(26,LOW,6000);assert(!processarEcos());assert(!valido(1));
  reset();pins[18]=HIGH;assert(!iniciarSensor(0));assert(fakeUs==0);
  assert(iniciarSensor(1)); // Um ECHO preso nao bloqueia o outro jogador.
  reset();falharTimer=true;assert(!iniciarSensor(0));assert(pins[5]==LOW);assert(!capturas[0].ativo);
  std::cout<<"OK captura por interrupcao, timeout, eco tardio e ECHO preso\n";

  reset();iniciarSensor(0);edge(18,HIGH,100);edge(18,LOW,100+us(20));
  fakeUs=600000;assert(processarEcos());assert(!valido(0)); // Nao rejuvenece eco antigo.
  reset();fakeUs=uint64_t(UINT32_MAX)-100;iniciarSensor(0);
  edge(18,HIGH,uint64_t(UINT32_MAX)-50);edge(18,LOW,uint64_t(UINT32_MAX)-50+us(20));
  assert(processarEcos());assert(fabs(sensores[0].distancia-20)<.05);
  std::cout<<"OK idade real do eco e rollover de micros\n";

  reset();fakeUs=INTERVALO_DISPAROS_US;loop();
  fakeUs=INTERVALO_DISPAROS_US*2;executarTimersFake();loop();
  fakeUs=INTERVALO_DISPAROS_US*3;executarTimersFake();loop();
  assert(disparos.size()==3&&disparos[0]==5&&disparos[1]==25&&disparos[2]==5);
  sequencia=UINT32_MAX-1;fakeUs=uint64_t(UINT32_MAX)*1000;
  sensores[0].amostras=UINT32_MAX;sensores[1].amostras=UINT32_MAX;publicar();
  const auto &json=websocket.mensagens.back();assert(json.size()<256);
  assert(json.find("\"seq\":4294967295")!=std::string::npos);
  assert(json.find("\"age\":4294967295")!=std::string::npos);
  assert(json.find("\"n\":4294967295")!=std::string::npos);
  std::cout<<"OK alternancia rapida e tamanho do pacote\n";

  reset();ultimoDisparo=UINT32_MAX-5000;fakeUs=uint64_t(UINT32_MAX)+INTERVALO_DISPAROS_US;
  loop();assert(disparos.size()==1); // Agendamento tambem atravessa rollover.
  std::cout<<"OK agendamento no rollover de micros\n";

  simularSensores(true);
  const uint32_t esperadas=1000000/(2*INTERVALO_DISPAROS_US);
  assert(sensores[0].amostras>=esperadas-1&&sensores[0].amostras<=esperadas+1);
  assert(sensores[1].amostras>=esperadas-1&&sensores[1].amostras<=esperadas+1);
  std::cout<<"OK simulacao de 1 s: "<<sensores[0].amostras<<" / "<<sensores[1].amostras<<" ecos aceitos\n";
  simularSensores(false);assert(sensores[0].amostras>=esperadas-1);assert(!sensores[1].recebido);
  std::cout<<"OK sensor ausente nao reduz a cadencia do outro\n";

  files["/game.js"]=std::make_shared<std::vector<uint8_t>>(std::initializer_list<uint8_t>{'a','n','t','i','g','o'});
  envio(UPLOAD_FILE_START);envio(UPLOAD_FILE_WRITE);assert(arquivo("/game.js")=="antigo");
  envio(UPLOAD_FILE_ABORTED);assert(arquivo("/game.js")=="antigo");assert(!files.count(UPLOAD_TEMP));
  envio(UPLOAD_FILE_START);writeFail=true;envio(UPLOAD_FILE_WRITE);writeFail=false;envio(UPLOAD_FILE_END);
  assert(!uploadFinalizado);assert(arquivo("/game.js")=="antigo");
  envio(UPLOAD_FILE_START);envio(UPLOAD_FILE_WRITE);renameFail=true;envio(UPLOAD_FILE_END);renameFail=false;
  assert(!uploadFinalizado);assert(arquivo("/game.js")=="antigo");
  envio(UPLOAD_FILE_START);envio(UPLOAD_FILE_END);assert(!uploadFinalizado);assert(arquivo("/game.js")=="antigo");
  envio(UPLOAD_FILE_START,"outro.txt");envio(UPLOAD_FILE_WRITE);envio(UPLOAD_FILE_END);
  assert(!uploadFinalizado);assert(!files.count("/outro.txt"));
  envio(UPLOAD_FILE_START);envio(UPLOAD_FILE_WRITE);envio(UPLOAD_FILE_END);
  assert(uploadFinalizado);assert(arquivo("/game.js")=="novo");assert(!files.count(UPLOAD_TEMP));
  std::cout<<"OK upload: aborto, escrita incompleta, falha ao substituir, vazio e sucesso\n";
  std::cout<<"Testes nativos passaram; interfaces Arduino foram simuladas.\n";
}
