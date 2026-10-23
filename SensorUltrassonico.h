#ifndef DUELO_SENSOR_ULTRASSONICO_H
#define DUELO_SENSOR_ULTRASSONICO_H

#include <stdint.h>
#include <math.h>

// Rapido: alvo de 16 ms por jogador. Experimental, abaixo dos >60 ms do datasheet.
// Se houver ecos cruzados, false restaura os 65 ms ENTRE sensores da base.
static const bool MODO_RAPIDO = true;
static const uint32_t INTERVALO_DISPAROS_US = MODO_RAPIDO ? 8000 : 65000;
static const uint32_t TEMPO_ECO_US = 5500;
static const uint32_t PRAZO_VALIDADE_MS = 500;
static const uint32_t PULSO_TRIG_US = 20; // >=10 us, produzido por esp_timer, sem espera
static const bool FILTRAR_SALTOS = true;
static const bool LOG_SENSORES = false;
static_assert(INTERVALO_DISPAROS_US > TEMPO_ECO_US + PULSO_TRIG_US,
              "O proximo disparo precisa ficar fora da janela de ECHO");

// Sem dependencia de Arduino: o mesmo filtro pode ser testado no computador.
struct Sensor {
  float distancia = 0;
  float pendente = 0;
  uint32_t pendenteEm = 0;
  bool haPendente = false;
  uint32_t ultimoEco = 0;
  uint32_t amostras = 0;
  bool recebido = false;

  bool valido(uint32_t agora) const {
    return recebido && uint32_t(agora - ultimoEco) < PRAZO_VALIDADE_MS;
  }

  bool registrarEco(uint32_t us, uint32_t agora) {
    const float cm = us * 0.0343f * 0.5f;
    if (us == 0 || cm < 3.0f || cm > 65.0f) return false;
    const bool retomando = !valido(agora);
    // Movimento normal passa na primeira medida. So saltos muito grandes pedem
    // uma segunda medida coerente; nao ha janela de mediana nem media em cascata.
    float limiteSalto = float(uint32_t(agora - ultimoEco)) * 0.25f;
    if (limiteSalto < 8.0f) limiteSalto = 8.0f;
    if (FILTRAR_SALTOS && !retomando && fabsf(cm - distancia) > limiteSalto) {
      const bool confirmou = haPendente && uint32_t(agora - pendenteEm) <= 200 &&
                             fabsf(cm - pendente) <= 3.0f;
      if (!confirmou) {
        pendente = cm;
        pendenteEm = agora;
        haPendente = true;
        return false;
      }
    }
    haPendente = false;
    if (retomando || fabsf(cm - distancia) >= 0.1f) distancia = cm;
    recebido = true;
    ultimoEco = agora;
    ++amostras;
    return true;
  }
};

// So a ISR escreve a duracao; o loop copia os campos dentro de uma secao critica.
struct CapturaEco {
  uint8_t pino = 0;
  volatile bool ativo = false;
  volatile bool subiu = false;
  volatile bool pronto = false;
  volatile uint32_t disparo = 0;
  volatile uint32_t inicio = 0;
  volatile uint32_t duracao = 0;
  volatile uint32_t concluido = 0;
};

#endif
