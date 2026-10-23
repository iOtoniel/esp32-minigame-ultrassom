'use strict';
// Node.js, sem dependencias. Executa o game.js real com DOM e WebSocket simulados.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'data/game.js'), 'utf8');
const ids = [...fs.readFileSync(path.join(root, 'data/index.html'), 'utf8')
  .matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
let total = 0;
function ambiente(demo=true, saved={}) {
  let now = 0;
  const sockets = [], intervals = [];
  const nodes = Object.fromEntries(ids.map(id => [id, {
    textContent:'', style:{}, hidden:false, disabled:false, open:false,
    value:id.startsWith('demo')?'20':'6', checked:false, width:360, height:540,
    listeners:{}, classList:{toggle(){}},
    addEventListener(event, fn) { this.listeners[event] = fn; },
    getContext() { return new Proxy({}, {get:()=>()=>{},set:()=>true}); }
  }]));
  class Socket {
    static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
    constructor(url) { this.url=url; this.readyState=0; this.listeners={}; sockets.push(this); }
    addEventListener(event, fn) { this.listeners[event]=fn; }
    emit(event, data) { if(event==='open') this.readyState=1; this.listeners[event]?.(data); }
    close() { this.readyState=3; this.emit('close'); }
    pacote(s, extras={}) { this.emit('message',{data:JSON.stringify({s,...extras})}); }
  }
  const storage={...saved};
  const context=vm.createContext({
    document:{hidden:false,getElementById:id=>{
      assert.ok(nodes[id], 'ID inexistente: '+id); return nodes[id];
    },addEventListener(){}},
    location:{search:demo?'?demo=1':'',hostname:'192.168.4.1'},
    performance:{now:()=>now}, URLSearchParams, WebSocket:Socket,
    localStorage:{getItem:k=>storage[k]??null,setItem:(k,v)=>{storage[k]=v;}},
    setInterval:fn=>intervals.push(fn), requestAnimationFrame(){}, console
  });
  vm.runInContext(source,context,{filename:'game.js'});
  return {nodes,sockets,intervals,storage,run:code=>vm.runInContext(code,context),
    time:t=>{now=t;}, packet:(s=[{cm:20,ok:true,age:0},{cm:20,ok:true,age:65}])=>{
      const sock=sockets.at(-1); if(sock.readyState===0) sock.emit('open');
      sock.pacote(s,{v:1});
    }};
}
function test(nome, fn) { fn(); total++; console.log('OK '+nome); }

test('sensibilidade 1–10 e a formula original em diferentes dt',()=>{
  const a=ambiente();
  a.run('players[0].direto=false;');
  for(let sens=1;sens<=10;sens++) for(const dt of [1/120,1/60,0.033]) {
    a.run(`players[0].sens=${sens}; players[0].suave=10; players[0].alvo=30; atualizar(${dt});`);
    const expected=10+20*(1-Math.pow(1-(0.025+(sens-1)*0.045),dt*60));
    assert.ok(Math.abs(a.run('players[0].suave')-expected)<1e-10);
  }
});
test('calibracao e sensibilidade de um jogador nao mudam o outro',()=>{
  const a=ambiente();
  a.nodes.sens0.listeners.input({target:{value:'10'}});
  a.run('leitura(0,12,true); players[0].cal.min=12; salvarCal(0);');
  assert.equal(a.run('players[0].sens'),10);
  assert.equal(a.run('players[1].sens'),6);
  assert.equal(a.run('players[1].cal.min'),10);
  a.nodes.inverter0.listeners.change({target:{checked:true}});
  assert.equal(a.run('players[0].cal.invert'),true);
  assert.equal(a.run('players[1].cal.invert'),false);
  assert.equal(JSON.parse(a.storage.dueloCalV1_0).min,12);
});
test('calibracao persistida invalida restaura 10–30 cm',()=>{
  const a=ambiente(true,{dueloCalV1_0:'{"min":20,"max":21}',dueloCalV1_1:'{ruim'});
  assert.equal(a.run('players[0].cal.min'),10);
  assert.equal(a.run('players[1].cal.max'),30);
});
test('perda de eco mantem a bola andando e conserva a posicao do goleiro',()=>{
  const a=ambiente();
  a.run('fase="jogando"; players[0].suave=15; players[0].alvo=30; leitura(0,0,false); atualizar(.033);');
  assert.ok(a.run('bola.y')>270);
  assert.equal(a.run('players[0].suave'),15);
});
test('resposta direta e padrao e aplica movimento no primeiro quadro',()=>{
  const a=ambiente();
  assert.equal(a.run('players[0].direto'),true);
  assert.equal(a.nodes.sens0.disabled,true);
  a.run('leitura(0,28,true); atualizar(1/120);');
  assert.equal(a.run('players[0].suave'),28);
  assert.ok(Math.abs(a.run('players[0].paddle.x')-248.4)<1e-8);
});
test('modo suave original pode ser ativado e persiste por jogador',()=>{
  const a=ambiente();
  a.nodes.direto0.listeners.change({target:{checked:false}});
  assert.equal(a.nodes.sens0.disabled,false);
  assert.equal(a.run('players[1].direto'),true);
  assert.equal(JSON.parse(a.storage.dueloDiretoV1_0),false);
  const b=ambiente(true,a.storage);
  assert.equal(b.run('players[0].direto'),false);
});
test('partida pode iniciar sem sensores e sem conexao',()=>{
  const a=ambiente(false);
  assert.equal(a.nodes.comecar.disabled,false);
  a.nodes.comecar.listeners.click();
  assert.equal(a.run('fase'),'sacando');
  a.run('atualizar(.7); atualizar(.033);');
  assert.equal(a.run('fase'),'jogando');
  assert.notEqual(a.run('bola.y'),270);
});
test('queda de rede nao pausa gol nem o placar',()=>{
  const a=ambiente(false);a.packet();
  a.run('fase="jogando"; Object.assign(bola,{x:20,y:-7,vx:0,vy:-300});');
  a.sockets[0].emit('close');a.run('atualizar(.033);');
  assert.equal(a.run('placar[0]'),1);
  assert.equal(a.run('fase'),'gol');
});
test('sem eco mantem a posicao e volta a seguir na primeira leitura recuperada',()=>{
  const a=ambiente();
  a.run('leitura(0,25,true); atualizar(.016); leitura(0,0,false); atualizar(.016);');
  const x=a.run('players[0].paddle.x');
  a.run('atualizar(.1);');assert.equal(a.run('players[0].paddle.x'),x);
  a.run('leitura(0,15,true); atualizar(.016);');
  assert.equal(a.run('players[0].suave'),15);
});
test('eco antigo continua indisponivel para capturar calibracao',()=>{
  const a=ambiente(false);a.packet();a.time(501);
  a.nodes.capturarMin0.listeners.click();
  assert.equal(a.run('players[0].cal.min'),10);
  assert.ok(a.nodes.feedback0.textContent.includes('valida'));
});
test('contador individual nao conta pacotes repetidos do outro jogador',()=>{
  const a=ambiente(false);
  for(let i=0;i<81;i++) {
    a.time(i*8);
    a.packet([{cm:20,ok:true,age:0,n:Math.floor(i/2)},
      {cm:20,ok:true,age:12,n:Math.floor((i+1)/2)}]);
  }
  assert.ok(a.run('players[0].hz')>60&&a.run('players[0].hz')<65);
});
test('contador atravessa uint32 e reinicio sem produzir frequencia absurda',()=>{
  const a=ambiente(false);
  a.packet([{cm:20,ok:true,age:0,n:4294967295},{cm:20,ok:true,age:0,n:8}]);
  a.time(16);a.packet([{cm:21,ok:true,age:0,n:0},{cm:20,ok:true,age:0,n:9}]);
  assert.equal(a.run('players[0].suave'),21);
  assert.equal(a.run('players[0].amostrasJanela'),1);
  a.time(32);a.packet([{cm:22,ok:true,age:0,n:1},{cm:20,ok:true,age:0,n:0}]);
  assert.equal(a.run('players[1].amostrasJanela'),0);
});
test('ultimo comando vence em uma rajada de pacotes',()=>{
  const a=ambiente(false);
  for(let n=0;n<15;n++) a.packet([{cm:10+n,ok:true,age:0,n},{cm:20,ok:true,age:12,n:0}]);
  a.run('atualizar(1/60);');assert.equal(a.run('players[0].suave'),24);
});
test('pacotes malformados nao renovam a conexao nem geram excecao',()=>{
  const a=ambiente(false); a.packet(); a.time(200);
  const invalidos=['{','null','{"s":[null,null]}','{"s":[{},{}]}',
    '{"s":[{"cm":null,"ok":true},{"cm":20,"ok":true}]}',
    '{"s":[{"cm":20,"ok":"false"},{"cm":20,"ok":true}]}',
    '{"s":[{"cm":70,"ok":true},{"cm":20,"ok":true}]}',
    '{"v":2,"s":[{"cm":20,"ok":true},{"cm":20,"ok":true}]}',
    '{"s":[{"cm":20,"ok":true,"age":-1},{"cm":20,"ok":true}]}'];
  for(const data of invalidos) a.sockets[0].emit('message',{data});
  assert.equal(a.run('ultimoPacote'),0);
  assert.equal(a.run('players[0].bruto'),20);
});
test('pacotes do firmware anterior continuam aceitos',()=>{
  const a=ambiente(false); a.sockets[0].emit('open');
  a.sockets[0].pacote([{cm:10,ok:true},{cm:30,ok:true}]);
  assert.equal(a.run('todosOk()'),true);
});
test('idade do eco nao se renova quando chega a leitura do outro jogador',()=>{
  const a=ambiente(false); a.time(1000); a.packet([{cm:20,ok:true,age:490},{cm:20,ok:true,age:0}]);
  assert.equal(a.run('conectado(0)'),true);
  a.time(1011);
  assert.equal(a.run('conectado(0)'),false);
  assert.equal(a.run('conectado(1)'),true);
});
test('socket aberto sem dados e encerrado e reconecta automaticamente',()=>{
  const a=ambiente(false); a.packet(); const old=a.sockets[0];
  a.time(701); a.run('vigiarConexao()');
  assert.equal(old.readyState,3); assert.equal(a.run('todosOk()'),false);
  a.time(1301); a.run('vigiarConexao()'); assert.equal(a.sockets.length,2);
  a.packet(); assert.equal(a.run('todosOk()'),true);
  old.emit('close'); assert.equal(a.run('todosOk()'),true);
  old.pacote([{cm:3,ok:true},{cm:3,ok:true}]);
  assert.equal(a.run('players[0].bruto'),20);
});
test('handshake travado tambem tem prazo e nova tentativa',()=>{
  const a=ambiente(false); a.time(4001); a.run('vigiarConexao()');
  assert.equal(a.sockets[0].readyState,3);
  a.time(4601); a.run('vigiarConexao()'); assert.equal(a.sockets.length,2);
});
test('abrir calibracao ou ocultar pagina pausa a partida',()=>{
  const a=ambiente(); a.run('fase="jogando";');
  a.nodes.cal0.open=true; a.run('atualizar(.033)'); assert.equal(a.run('bola.y'),270);
  a.nodes.cal0.open=false; a.run('document.hidden=true; atualizar(.033)');
  assert.equal(a.run('bola.y'),270);
});
test('defesa usa o ponto de contato mesmo quando o fim do quadro ja passou da borda',()=>{
  const a=ambiente();
  a.run('fase="jogando"; players[0].paddle.x=100; Object.assign(bola,{x:189,y:490,vx:200,vy:300}); avancarBola(.033);');
  assert.ok(a.run('bola.vy')<0); assert.equal(a.run('placar[1]'),0);
});
test('nao inventa defesa quando a bola so alcanca o goleiro depois de passar do plano',()=>{
  const a=ambiente();
  a.run('fase="jogando"; players[0].paddle.x=100; Object.assign(bola,{x:197,y:490,vx:-200,vy:300}); avancarBola(.033);');
  assert.ok(a.run('bola.vy')>0);
});
test('parede e defesa no mesmo quadro preservam a bola no campo',()=>{
  const a=ambiente();
  a.run('fase="jogando"; players[0].paddle.x=276; Object.assign(bola,{x:351,y:490,vx:150,vy:300}); avancarBola(.033);');
  assert.ok(a.run('bola.x')<=352); assert.ok(a.run('bola.vy')<0);
});
test('gols somam uma vez e a partida termina aos sete',()=>{
  const a=ambiente();
  a.run('fase="jogando"; placar=[6,0]; Object.assign(bola,{x:20,y:-7,vx:0,vy:-300}); avancarBola(.033); avancarBola(.033);');
  assert.equal(a.run('placar[0]'),7); assert.equal(a.run('fase'),'fim');
});
test('velocidade respeita o teto em ralis longos',()=>{
  const a=ambiente();
  for(let i=0;i<100;i++) a.run('bola.x=players[0].paddle.x+70; rebatida(players[0],-1);');
  assert.ok(a.run('Math.hypot(bola.vx,bola.vy)')<=420.00001);
});
test('colisoes permanecem finitas em varios angulos e dt',()=>{
  const a=ambiente();
  a.run(`for(let i=0;i<3000;i++) {
    fase='jogando'; placar=[0,0];
    bola.x=8+(i*73)%344; bola.y=48+(i*19)%440;
    const angulo=i*2.399963229728653;
    bola.vx=Math.sin(angulo)*420; bola.vy=Math.cos(angulo)*420;
    for(let j=0;j<20 && fase==='jogando';j++) avancarBola(.033);
    if(!Number.isFinite(bola.x+bola.y+bola.vx+bola.vy) || bola.x<7.99999 || bola.x>352.00001)
      throw Error('Trajetoria invalida '+i);
  }`);
});
console.log(total+' testes JavaScript passaram.');
