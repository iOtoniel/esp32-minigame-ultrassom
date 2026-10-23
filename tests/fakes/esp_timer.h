#pragma once
#include "ArduinoFake.h"
using esp_err_t=int;
static const esp_err_t ESP_OK=0;
struct esp_timer_create_args_t {
  void (*callback)(void*)=nullptr;
  void *arg=nullptr;
  const char *name=nullptr;
};
struct TimerFake {
  esp_timer_create_args_t args;
  uint64_t prazo=0;
  bool ativo=false;
};
using esp_timer_handle_t=TimerFake*;
static TimerFake timerFake;
static bool falharTimer=false;
inline esp_err_t esp_timer_create(const esp_timer_create_args_t *args,esp_timer_handle_t *out){
  timerFake.args=*args;*out=&timerFake;return ESP_OK;
}
inline esp_err_t esp_timer_start_once(esp_timer_handle_t timer,uint64_t timeout){
  if(falharTimer||timer->ativo)return -1;
  timer->prazo=fakeUs+timeout;timer->ativo=true;return ESP_OK;
}
inline void executarTimersFake(){
  if(timerFake.ativo&&fakeUs>=timerFake.prazo){
    timerFake.ativo=false;timerFake.args.callback(timerFake.args.arg);
  }
}
