'use strict';
// ESP32 Arcade Duelo. Dois sensores; jogo em uma tela principal.
const $ = id => document.getElementById(id);
const tela = $('jogo'), ctx = tela.getContext('2d');
const W = tela.width, H = tela.height;
const MAX_PONTOS = 7, MIN_FAIXA = 6;
const PRAZO_PACOTE_MS = 700, PRAZO_SENSOR_MS = 500;
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const clampa = (n, a, b) => Math.max(a, Math.min(b, n));
const media = (a, b) => (a + b) * 0.5;
const salvar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
function carregar(k, fallback) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? fallback : v; }
  catch (_) { return fallback; }
}

const players = [0, 1].map(i => {
  const salvo = carregar('dueloCalV1_' + i, {min:10, max:30, invert:false});
  const cal = salvo && Number.isFinite(salvo.min) && Number.isFinite(salvo.max) &&
    salvo.min >= 3 && salvo.max <= 65 && salvo.max - salvo.min >= MIN_FAIXA
    ? {min:salvo.min, max:salvo.max, invert:!!salvo.invert} : {min:10, max:30, invert:false};
  return {
    i, cal, sens:6, bruto:null, alvo:media(cal.min,cal.max), suave:media(cal.min,cal.max),
    direto:carregar('dueloDiretoV1_'+i,true) !== false,
    amostra:null, janelaEm:0, amostrasJanela:0, hz:null,
    inicializado:false, atualizado:0, valido:false,
    paddle:{x:(W-84)/2, y:i===0?H-39:27, w:84, h:12},
    cor:i===0?'#38bdf8':'#fb7185'
  };
});
let ws = null, ultimoPacote = -Infinity, fase = 'inicio', contagem = 0;
let inicioConexao = 0, proximaConexao = 0, atrasoReconexao = 600;
let placar = [0, 0], mensagemGol = '', ultimoOverlay = '';
let anterior = 0;
let ultimoUI = -Infinity;
const bola = {x:W/2, y:H/2, vx:45, vy:180, r:8};

function conectado(i) {
  if (DEMO) return players[i].valido;
  return !!(ws && ws.readyState === WebSocket.OPEN &&
    performance.now() - ultimoPacote < PRAZO_PACOTE_MS && players[i].valido &&
    performance.now() - players[i].atualizado < PRAZO_SENSOR_MS);
}
function todosOk() { return conectado(0) && conectado(1); }
function atualizarIndicacao(i) {
  const p = players[i];
  $('cm'+i).textContent = !conectado(i) || p.bruto === null ? '--' : p.bruto.toFixed(1).replace('.',',');
  const temRede = DEMO || (ws && ws.readyState === WebSocket.OPEN &&
    performance.now() - ultimoPacote < PRAZO_PACOTE_MS);
  $('status'+i).textContent = conectado(i) ? '● Pronto' : temRede ? '● Sem eco · posição mantida' : '● Sem conexão';
  $('status'+i).style.color = conectado(i) ? '#4ade80' : '#fbbf24';
  const idade = Math.max(0,Math.round(performance.now()-p.atualizado));
  $('telemetria'+i).textContent = conectado(i)
    ? (p.hz===null?'Medindo frequência':p.hz.toFixed(0)+' leituras/s')+' · eco há '+idade+' ms'
    : 'Última posição mantida · partida continua';
}
function leitura(i, valor, ok, idade=0, amostra=null) {
  const p = players[i];
  // Pacotes alternados repetem o outro sensor. Nao enfileira nem conta repeticoes.
  if (ok && p.valido && amostra !== null && p.amostra === amostra) return;
  p.valido = !!ok && Number.isFinite(valor);
  if (p.valido) {
    const agora = performance.now();
    if (amostra !== null) {
      const delta = p.amostra===null ? 0 : (amostra-p.amostra)>>>0;
      if (p.amostra===null || delta>1000) {
        p.janelaEm=agora; p.amostrasJanela=0; p.hz=null;
      } else p.amostrasJanela+=delta;
      if (agora-p.janelaEm>=500) {
        p.hz=p.amostrasJanela*1000/(agora-p.janelaEm);
        p.janelaEm=agora; p.amostrasJanela=0;
      }
      p.amostra=amostra;
    }
    p.bruto = valor;
    p.alvo = clampa(valor, p.cal.min, p.cal.max);
    p.atualizado = performance.now() - idade;
    if (p.direto || !p.inicializado) {
      p.suave = p.alvo;
      p.inicializado = true;
    }
  } else {
    p.bruto = null;
    p.inicializado = false;
  }
}
// Aceita tambem o pacote da versao anterior, sem v/age. Nao converte null em zero.
function interpretarPacote(texto) {
  let dados;
  try { dados = JSON.parse(texto); } catch (_) { return null; }
  if (!dados || (dados.v !== undefined && dados.v !== 1) ||
      !Array.isArray(dados.s) || dados.s.length !== 2) return null;
  if (!dados.s.every(s => s && typeof s.ok === 'boolean' && Number.isFinite(s.cm) &&
      (!s.ok || (s.cm >= 3 && s.cm <= 65)) &&
      (s.age === undefined || (Number.isFinite(s.age) && s.age >= 0)) &&
      (s.n === undefined || (Number.isInteger(s.n) && s.n>=0 && s.n<=4294967295)))) return null;
  return dados.s;
}
function invalidarConexao(texto) {
  $('rede').textContent = texto;
  $('rede').style.color = '#f87171';
  players.forEach((p,i) => leitura(i,0,false));
}
function reconectar(texto) {
  const antiga = ws;
  ws = null; // Eventos atrasados da conexao antiga nao afetam a nova.
  invalidarConexao(texto);
  proximaConexao = performance.now() + atrasoReconexao;
  atrasoReconexao = Math.min(4800, atrasoReconexao * 2);
  if (antiga && antiga.readyState !== WebSocket.CLOSED) antiga.close();
}
function conectar() {
  if (DEMO) return;
  if (ws && [WebSocket.CONNECTING,WebSocket.OPEN].includes(ws.readyState)) return;
  $('rede').textContent = 'Conectando...';
  $('rede').style.color = '#fbbf24';
  inicioConexao = performance.now();
  ultimoPacote = -Infinity;
  let socket;
  try { socket = new WebSocket('ws://' + location.hostname + ':81/'); }
  catch (_) { reconectar('● Falha ao conectar'); return; }
  ws = socket;
  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    inicioConexao = performance.now();
    players.forEach(p=>{p.amostra=null;p.hz=null;});
    $('rede').textContent = '● Aguardando dados';
  });
  socket.addEventListener('message', e => {
    if (ws !== socket) return;
    const sensores = interpretarPacote(e.data);
    if (!sensores) return;
    ultimoPacote = performance.now();
    atrasoReconexao = 600;
    if ($('rede').textContent !== '● Wi-Fi conectado') {
      $('rede').textContent = '● Wi-Fi conectado';
      $('rede').style.color = '#4ade80';
    }
    sensores.forEach((s, i) => leitura(i, s.cm,
      s.ok && (s.age === undefined || s.age < PRAZO_SENSOR_MS), s.age || 0,
      s.n === undefined ? null : s.n));
  });
  const caiu = () => {
    if (ws === socket) reconectar('● Sem conexão');
  };
  socket.addEventListener('error', caiu);
  socket.addEventListener('close', caiu);
}
function vigiarConexao() {
  if (DEMO) return;
  const agora = performance.now();
  if (!ws) {
    if (agora >= proximaConexao) conectar();
  } else if (ws.readyState === WebSocket.CONNECTING && agora - inicioConexao > 4000) {
    reconectar('● Conexão sem resposta');
  } else if (ws.readyState === WebSocket.OPEN &&
      agora - Math.max(ultimoPacote, inicioConexao) >= PRAZO_PACOTE_MS) {
    reconectar('● Dados interrompidos');
  } else if ([WebSocket.CLOSING,WebSocket.CLOSED].includes(ws.readyState)) {
    reconectar('● Sem conexão');
  }
}
if (DEMO) {
  $('demo').hidden = false;
  $('rede').textContent = '● Simulador';
  $('rede').style.color = '#fbbf24';
  for (let i=0;i<2;i++) {
    $('demo'+i).addEventListener('input', e => leitura(i, Number(e.target.value), true));
    leitura(i, Number($('demo'+i).value), true);
  }
} else {
  conectar();
  setInterval(vigiarConexao, 200);
}

function posicaoInicial(p) {
  p.alvo = clampa(p.bruto === null ? media(p.cal.min,p.cal.max) : p.bruto, p.cal.min, p.cal.max);
  p.suave = p.alvo;
}
function salvarCal(i) {
  salvar('dueloCalV1_' + i, players[i].cal);
  mostrarCal(i);
  posicaoInicial(players[i]);
}
function mostrarCal(i) {
  const c = players[i].cal;
  $('min'+i).textContent = c.min.toFixed(1).replace('.',',')+' cm';
  $('max'+i).textContent = c.max.toFixed(1).replace('.',',')+' cm';
  $('inverter'+i).checked = c.invert;
}
function mensagemCal(i, texto, ok=false) {
  $('feedback'+i).textContent = texto;
  $('feedback'+i).style.color = ok ? '#4ade80' : '#fbbf24';
}
function configurar(i) {
  const p = players[i];
  mostrarCal(i);
  const mostrarModo = () => {
    $('direto'+i).checked=p.direto;
    $('sens'+i).disabled=p.direto;
    $('modo'+i).textContent=p.direto
      ? 'Resposta direta ativa. Desative para usar a sensibilidade.'
      : 'Suavização original: ajuste a sensibilidade abaixo.';
  };
  mostrarModo();
  $('direto'+i).addEventListener('change',e=>{
    p.direto=e.target.checked;
    salvar('dueloDiretoV1_'+i,p.direto);
    if (p.direto && conectado(i)) p.suave=p.alvo;
    mostrarModo();
  });
  $('sens'+i).addEventListener('input', e => {
    p.sens = Number(e.target.value);
    $('nivel'+i).textContent = String(p.sens);
  });
  $('inverter'+i).addEventListener('change', e => {
    p.cal.invert = e.target.checked;
    salvarCal(i);
    mensagemCal(i,'Sentido do movimento atualizado.',true);
  });
  $('capturarMin'+i).addEventListener('click', () => {
    if (!conectado(i) || p.bruto === null) return mensagemCal(i,'Posicione a mao ate obter uma leitura valida.');
    if (p.bruto > p.cal.max - MIN_FAIXA || p.bruto < 3) return mensagemCal(i,'Perto precisa ficar 6 cm antes do limite longe.');
    p.cal.min = Number(p.bruto.toFixed(1));
    salvarCal(i); mensagemCal(i,'Limite proximo capturado!',true);
  });
  $('capturarMax'+i).addEventListener('click', () => {
    if (!conectado(i) || p.bruto === null) return mensagemCal(i,'Posicione a mao ate obter uma leitura valida.');
    if (p.bruto < p.cal.min + MIN_FAIXA || p.bruto > 65) return mensagemCal(i,'Longe precisa ficar 6 cm apos o limite perto.');
    p.cal.max = Number(p.bruto.toFixed(1));
    salvarCal(i); mensagemCal(i,'Limite distante capturado!',true);
  });
  $('padrao'+i).addEventListener('click', () => {
    p.cal.min = 10; p.cal.max = 30;
    salvarCal(i); mensagemCal(i,'Faixa 10–30 cm restaurada.',true);
  });
}
configurar(0); configurar(1);

function atualizaPlacar() {
  $('pontos0').textContent = String(placar[0]);
  $('pontos1').textContent = String(placar[1]);
}
function servir(direcao) {
  bola.x = W/2; bola.y = H/2;
  const angulo = (Math.random() - 0.5) * 0.75;
  const v = 195;
  bola.vx = Math.sin(angulo) * v;
  bola.vy = (direcao < 0 ? -1 : 1) * Math.cos(angulo) * v;
  // Da aos jogadores tempo de preparar a posicao.
  contagem = 0.6;
  fase = 'sacando';
}
function iniciar() {
  if (estaCalibrando()) return;
  placar = [0,0]; atualizaPlacar();
  for (const p of players) posicaoInicial(p);
  mensagemGol = '';
  servir(Math.random() < 0.5 ? -1 : 1);
  mostrarOverlay();
}
$('comecar').addEventListener('click', iniciar);
$('reiniciar').addEventListener('click', () => {
  fase = 'inicio'; placar = [0,0]; atualizaPlacar(); mensagemGol = '';
  mostrarOverlay();
});
function estaCalibrando() { return $('cal0').open || $('cal1').open; }
function mostrarOverlay() {
  const calibrando = estaCalibrando();
  const deve = fase === 'inicio' || fase === 'fim' || calibrando;
  $('overlay').classList.toggle('oculto', !deve);
  $('comecar').disabled = calibrando;
  if (!deve) return;
  let titulo, mensagem, botao = '';
  if (calibrando) {
    titulo = 'Calibrando...';
    mensagem = 'Feche os paineis de calibracao para continuar a partida.';
  } else if (fase === 'fim') {
    titulo = 'Goleiro '+(placar[0]>placar[1]?'azul':'vermelho')+' venceu!';
    mensagem = 'Placar final: '+placar[0]+' x '+placar[1];
    botao = 'Nova partida';
  } else if (fase === 'inicio') {
    titulo = 'Duelo de goleiros';
    mensagem = 'Controle as raquetes com as maos. Marque '+MAX_PONTOS+' gols para vencer. Sem eco, o goleiro mantém a posição e a partida continua.';
    botao = 'Iniciar partida';
  }
  const chave = [titulo,mensagem,botao].join('|');
  if (chave === ultimoOverlay) return;
  ultimoOverlay = chave;
  $('titulo').textContent = titulo;
  $('mensagem').textContent = mensagem;
  $('comecar').hidden = !botao;
  if (botao) $('comecar').textContent = botao;
}

function rebatida(p, lado) {
  const r = p.paddle;
  const contato = clampa((bola.x-(r.x+r.w/2))/(r.w/2),-1,1);
  const angulo = contato * 0.89;
  const velocidade = Math.min(420,Math.hypot(bola.vx,bola.vy)*1.035+3);
  bola.vx = velocidade*Math.sin(angulo);
  // Retas perfeitas ficam monotonas: um pequeno desvio minimo.
  if (Math.abs(bola.vx)<27) bola.vx = (bola.vx<0?-1:1)*27;
  bola.vy = lado*Math.sqrt(Math.max(80*80,velocidade*velocidade-bola.vx*bola.vx));
}
function fazerGol(vencedor) {
  placar[vencedor]++; atualizaPlacar();
  mensagemGol = 'GOL DO '+(vencedor===0?'AZUL!':'VERMELHO!');
  if (placar[vencedor] >= MAX_PONTOS) {
    fase = 'fim';
  } else {
    fase = 'gol'; contagem = 1.25;
  }
  mostrarOverlay();
}
// Resolve o instante de contato. Evita testar a borda usando apenas o fim do quadro.
// As paredes sao resolvidas primeiro quando ocorrem antes da defesa.
function avancarBola(dt) {
  let restante = dt;
  for (let passo=0; passo<8 && restante>0.0000001 && fase==='jogando'; passo++) {
    let tempo = restante, tipo = '', jogador = null, lado = 0;
    const candidato = (t, evento, p=null, direcao=0) => {
      if (t >= -0.0000001 && t <= tempo) {
        tempo = Math.max(0,t); tipo = evento; jogador = p; lado = direcao;
      }
    };
    if (bola.vx < 0) candidato((bola.r-bola.x)/bola.vx, 'parede');
    if (bola.vx > 0) candidato((W-bola.r-bola.x)/bola.vx, 'parede');
    const p = bola.vy < 0 ? players[1] : players[0];
    const r = p.paddle;
    const plano = bola.vy < 0 ? r.y+r.h+bola.r : r.y-bola.r;
    if (bola.vy !== 0) {
      const t = (plano-bola.y)/bola.vy;
      const x = bola.x+bola.vx*t;
      if (x+bola.r >= r.x && x-bola.r <= r.x+r.w) {
        candidato(t, 'defesa', p, bola.vy<0 ? 1 : -1);
      }
      candidato(((bola.vy<0 ? -bola.r : H+bola.r)-bola.y)/bola.vy, 'gol',
        null, bola.vy<0 ? 0 : 1);
    }
    bola.x += bola.vx*tempo;
    bola.y += bola.vy*tempo;
    restante -= tempo;
    if (tipo === 'parede') {
      bola.x = clampa(bola.x,bola.r,W-bola.r);
      bola.vx = -bola.vx;
    } else if (tipo === 'defesa') {
      rebatida(jogador,lado);
    } else if (tipo === 'gol') {
      fazerGol(lado);
      return;
    } else return;
  }
}
function atualizar(dt) {
  for (const p of players) {
    // Mesma formula da sensibilidade do projeto anterior, compensada pelo dt.
    const fator = 0.025 + (p.sens - 1)*0.045;
    const peso = 1 - Math.pow(1 - fator,dt*60);
    if (conectado(p.i)) {
      if (p.direto) p.suave=p.alvo;
      else p.suave += (p.alvo-p.suave)*peso;
    }
    let proporcao = clampa((p.suave-p.cal.min)/(p.cal.max-p.cal.min),0,1);
    if (p.cal.invert) proporcao = 1-proporcao;
    p.paddle.x = proporcao*(W-p.paddle.w);
  }
  if (estaCalibrando() || document.hidden) return;
  if (fase === 'inicio' || fase === 'fim') return;
  if (fase === 'gol') {
    contagem -= dt;
    if (contagem <= 0) servir(placar[0] > placar[1] ? -1 : 1);
    return;
  }
  if (fase === 'sacando') {
    contagem -= dt;
    if (contagem <= 0) { fase='jogando'; mensagemGol=''; }
    return;
  }
  avancarBola(dt);
}
function atualizarUI() {
  $('statusGeral').textContent = todosOk()?'● Ambos os sensores prontos':'● Leitura ausente · partida continua';
  for (const p of players) {
    let proporcao=clampa((p.suave-p.cal.min)/(p.cal.max-p.cal.min),0,1);
    if (p.cal.invert) proporcao=1-proporcao;
    $('marcador'+p.i).style.left=(proporcao*100)+'%';
    atualizarIndicacao(p.i);
  }
  mostrarOverlay();
}
function desenhar() {
  ctx.clearRect(0,0,W,H); // Gramado PNG fica atras do canvas.
  for (const p of players) {
    const r=p.paddle;
    ctx.fillStyle='#081b26';ctx.fillRect(r.x-2,r.y-2,r.w+4,r.h+4);
    ctx.fillStyle=p.cor;ctx.fillRect(r.x,r.y,r.w,r.h);
    ctx.fillStyle='#e5faff';ctx.fillRect(r.x+6,r.y+2,r.w-12,3);
  }
  ctx.save();ctx.shadowColor='#000';ctx.shadowBlur=10;
  ctx.fillStyle='#f9fafb';ctx.beginPath();ctx.arc(bola.x,bola.y,bola.r,0,Math.PI*2);ctx.fill();
  ctx.shadowBlur=0;ctx.strokeStyle='#152533';ctx.lineWidth=1.2;
  // Detalhes da bola, estilo retrô simples.
  ctx.beginPath();ctx.moveTo(bola.x-2,bola.y-3);ctx.lineTo(bola.x+3,bola.y-1);ctx.lineTo(bola.x+1,bola.y+4);ctx.lineTo(bola.x-4,bola.y+2);ctx.closePath();ctx.stroke();
  ctx.restore();
  $('avisoGol').hidden = fase !== 'gol';
  if (fase === 'gol') $('avisoGol').textContent = mensagemGol;
}
function quadro(agora) {
  const dt = anterior ? Math.min((agora-anterior)/1000,0.033) : 1/60;
  anterior=agora;
  if (agora-ultimoUI>=100) {ultimoUI=agora;atualizarUI();}
  atualizar(dt);desenhar();requestAnimationFrame(quadro);
}
atualizarUI();
requestAnimationFrame(quadro);
document.addEventListener('visibilitychange', () => {
  anterior = 0;
  if (!document.hidden) vigiarConexao();
});
