#pragma once
// Dubles minimos para testar o firmware nativo. Nao substituem o core ESP32.
#include <stdint.h>
#include <stddef.h>
#include <string>
#include <vector>
#include <map>
#include <memory>
#include <functional>
#include <cstdio>

#define PROGMEM
#define IRAM_ATTR
#define LOW 0
#define HIGH 1
#define INPUT 0
#define OUTPUT 1
#define CHANGE 3
#define WIFI_AP 2
#define HTTP_GET 0
#define HTTP_POST 1
#define portMUX_INITIALIZER_UNLOCKED 0
using portMUX_TYPE=int;
#define portENTER_CRITICAL(x) ((void)(x))
#define portEXIT_CRITICAL(x) ((void)(x))
#define portENTER_CRITICAL_ISR(x) ((void)(x))
#define portEXIT_CRITICAL_ISR(x) ((void)(x))
static uint64_t fakeUs=0;
static int pins[40]={0};
static void (*interrupts[40])(void*)={};
static void *interruptArgs[40]={};
static std::vector<int> disparos;
inline uint32_t micros(){return uint32_t(fakeUs);}
inline uint32_t millis(){return uint32_t(fakeUs/1000);}
inline void executarTimersFake();
inline void pinMode(int,int){}
inline int digitalRead(int p){return pins[p];}
inline void digitalWrite(int p,int v){pins[p]=v;if(v==HIGH)disparos.push_back(p);}
inline void attachInterruptArg(int p,void (*fn)(void*),void *arg,int){interrupts[p]=fn;interruptArgs[p]=arg;}
inline void edge(int p,int v,uint64_t t){fakeUs=t;executarTimersFake();pins[p]=v;if(interrupts[p])interrupts[p](interruptArgs[p]);}

class String {
  std::string s;
public:
  String()=default; String(const char *v):s(v){} String(std::string v):s(v){}
  bool operator==(const char *v)const{return s==v;}
  void replace(const char *a,const char *b){size_t p=0;while((p=s.find(a,p))!=std::string::npos){s.replace(p,std::string(a).size(),b);p+=std::string(b).size();}}
  int lastIndexOf(char c)const{auto p=s.rfind(c);return p==std::string::npos?-1:int(p);}
  String substring(size_t p)const{return s.substr(p);}
  size_t length()const{return s.size();} const char *c_str()const{return s.c_str();}
  friend String operator+(const char *a,const String &b){return std::string(a)+b.s;}
};
struct SerialFake {
  void begin(int){} template<class T>void print(T){} template<class T>void println(T){}
  template<class... T>void printf(const char*,T...){}
};
static SerialFake Serial;
static std::map<std::string,std::shared_ptr<std::vector<uint8_t>>> files;
static bool writeFail=false, renameFail=false;
class File {
  std::shared_ptr<std::vector<uint8_t>> data;
public:
  File()=default; File(std::shared_ptr<std::vector<uint8_t>> d):data(d){}
  operator bool()const{return bool(data);} bool isDirectory()const{return false;}
  size_t write(const uint8_t *p,size_t n){if(!data||writeFail)return 0;data->insert(data->end(),p,p+n);return n;}
  void close(){data.reset();}
};
struct LittleFSFake {
  bool begin(bool){return true;}
  File open(const String &p,const char *mode){
    std::string key=p.c_str();
    if(mode[0]=='w')files[key]=std::make_shared<std::vector<uint8_t>>();
    auto it=files.find(key);return it==files.end()?File():File(it->second);
  }
  bool remove(const String &p){return files.erase(p.c_str())>0;}
  bool rename(const String &a,const String &b){
    if(renameFail||!files.count(a.c_str()))return false;
    files[b.c_str()]=files[a.c_str()];files.erase(a.c_str());return true;
  }
};
static LittleFSFake LittleFS;
enum {UPLOAD_FILE_START,UPLOAD_FILE_WRITE,UPLOAD_FILE_END,UPLOAD_FILE_ABORTED};
struct HTTPUpload {int status=0;String filename;size_t currentSize=0;uint8_t *buf=nullptr;};
class WebServer {
public:
  HTTPUpload incoming;
  WebServer(int){} HTTPUpload &upload(){return incoming;}
  template<class... T>void on(T...){} template<class T>void onNotFound(T){}
  template<class... T>void send(T...){} template<class... T>void send_P(T...){}
  template<class... T>void sendHeader(T...){} template<class... T>void streamFile(T...){}
  void begin(){} void handleClient(){}
};
enum WStype_t {WStype_CONNECTED,WStype_DISCONNECTED};
class WebSocketsServer {
public:
  std::vector<std::string> mensagens;
  WebSocketsServer(int){} int connectedClients(){return 1;}
  void broadcastTXT(char *data,size_t n){mensagens.emplace_back(data,n);}
  template<class T>void onEvent(T){} void enableHeartbeat(int,int,int){}
  void begin(){} void loop(){}
};
struct WiFiFake {
  void mode(int){} bool softAP(const char*,const char*){return true;}
  const char *softAPIP(){return "192.168.4.1";}
};
static WiFiFake WiFi;
