# Testes

Os testes automatizados exercitam a lógica do projeto no computador. Eles usam o código de produção com substitutos para o DOM, o WebSocket, os GPIOs e o timer, de modo que os cenários possam ser repetidos sem uma placa conectada.

## Executar no computador

Requisitos: Node.js e um compilador g++ com suporte a C++11. Execute os comandos na raiz do projeto:

```bash
node --check data/game.js
node tests/game.test.cjs
g++ -std=c++11 -Wall -Wextra -Werror -pedantic -I tests/fakes tests/firmware.test.cpp -o firmware-test
./firmware-test
```

No Windows, o compilador pode gerar `firmware-test.exe`; nesse caso, ajuste o último comando ao terminal utilizado. Esses comandos não gravam o ESP32.

## Cobertura

| Conjunto | Cenários principais |
|---|---|
| Controles | Resposta direta, fórmula de sensibilidade nos dez níveis, calibração e inversão independentes |
| Persistência | Recuperação de configuração inválida e preferência de modo por jogador |
| Perda de leitura | Última posição mantida, retorno da leitura e partida iniciada ou continuada sem sensores |
| Rede | JSON inválido, socket sem dados, reconexão, eventos de conexão antiga e compatibilidade de pacotes |
| Contadores | Leituras repetidas, retorno a zero após o limite de uint32 e reinício do firmware |
| Jogo | Defesas nas bordas, parede e defesa no mesmo quadro, limite de velocidade, gols e fim de partida |
| Sensores | Aceitação da primeira amostra normal, rejeição de salto isolado, confirmação de mudança grande e prazo de validade |
| Temporização | Pulso TRIG por timer, falha do timer, timeout, eco tardio e retorno do relógio após seu limite numérico |
| Independência | Um transmissor de cada vez e um sensor ausente sem impedir a leitura do outro |
| Upload | Aborto, arquivo vazio, nome inválido, falha de escrita, falha de substituição e sucesso |

A versão documentada passou nos 25 testes JavaScript e nos testes C++ nativos. A simulação de um segundo com os dois sensores produziu 62 ecos aceitos por jogador no modo rápido. Há também um teste de três mil trajetórias da bola para verificar limites e resultados finitos.

## O que ainda depende da montagem

Os substitutos usados nos testes não reproduzem ruído elétrico, reflexões acústicas, concorrência entre núcleos, atrasos de interrupção, tarefa do timer sob Wi-Fi ou o filesystem real da placa. Por isso, os resultados automatizados não substituem a compilação para ESP32 e o teste do circuito.

Antes de uma demonstração, confira:

1. **Ambiente:** registre a placa, a versão do core ESP32, a versão da WebSockets e o esquema de partições utilizado.
2. **Circuito:** confirme VCC, GND comum e os valores dos dois divisores. Verifique o nível de tensão previsto nas entradas antes de conectar os ECHOs ao ESP32.
3. **Inicialização:** grave o firmware, abra a serial a 115200 baud e confira a criação da rede.
4. **Arquivos:** envie os quatro itens de `data` e abra o jogo sem depender de internet.
5. **Cada jogador:** teste uma mão por vez, em posições próximas, intermediárias e distantes. Apenas o goleiro correspondente deve responder.
6. **Dois jogadores:** repita o movimento com ambos os sensores ativos e observe possíveis leituras cruzadas.
7. **Controles:** calibre faixas distintas, inverta somente um jogador e compare resposta direta com os níveis 1, 6 e 10 da suavização.
8. **Perda de eco:** retire uma mão durante a partida. O goleiro deve manter a posição, e bola e placar devem continuar. Ao retornar, o controle deve acompanhar a próxima leitura aceita.
9. **Rede:** desconecte e reconecte o Wi-Fi da tela. A página deve tentar recuperar a comunicação sem reiniciar o placar.
10. **Cadência:** compare o modo rápido com intervalos intermediários e com o modo conservador. Registre o ajuste que manteve leituras consistentes na montagem.
11. **Temporização física:** se houver analisador lógico, observe TRIG e ECHO para conferir o pulso mínimo, a alternância e o comportamento sob tráfego de Wi-Fi.
12. **Uso contínuo:** execute várias partidas e observe estabilidade, travamentos, reinicializações e variação da resposta.

Para comparar a latência do controle, uma gravação em alta taxa de quadros pode enquadrar a mão e a tela simultaneamente. Repita o teste com mudanças de direção e nas mesmas condições de montagem. A idade do eco mostrada na interface não representa, sozinha, o tempo total entre o movimento físico e a resposta visual.
