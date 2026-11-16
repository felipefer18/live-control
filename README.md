# Live Control

Painel local para controlar lives: OBS, Twitch, LivePix, molduras neon, alertas, metas, comandos de chat e cortes.

> **Demonstração:** abra `demo.html` no navegador para ver o painel funcionando com dados simulados, sem OBS, Twitch nem LivePix.

## Primeira vez
0. Na primeira execução o app cria o `config.json` a partir do `config.example.json`. O `config.json` e a pasta `data/` guardam suas chaves e **não vão para o Git** (estão no `.gitignore`).
1. **OBS:** Ferramentas > Configurações do WebSocket > ativar o servidor (porta 4455). Se usar senha, coloque em `config.json` > `obs.password`.
2. `npm install` (só na primeira vez) e depois `npm start`.
3. Abra http://localhost:3000. No celular (mesmo Wi-Fi), use o endereço que aparece no terminal.
4. Aba **Visual:** preencha nome do canal, frase, redes e o nome da sua webcam, depois clique em **Montar cenas no OBS**.

## Visual (aba Visual)
Estilo **neon vibrante** em todos os jogos, com a cor de cada um (CS2 laranja, LoL azul, Ron Run verde).
- **Duas telas por jogo (lobby e partida):**
  - **Lobby** (antes da partida, no client): moldura completa. O jogo fica a 80% e sobra um painel com webcam, chat ao vivo, QR da LivePix, metas e redes.
  - **Partida:** o jogo vai para **tela cheia** e só ficam a **webcam** (com borda neon) e o **QR**. Sem chat, metas nem faixas, para não atrapalhar a visão.
  - A posição da webcam na partida é de cada jogo (X, Y, largura e altura, numa tela de 1920x1080). Padrão: LoL no canto de cima à esquerda; CS2 na lateral esquerda, mais abaixo (o radar ocupa o canto); Ron Run no canto de cima à esquerda.
- **QR code da LivePix:** gerado a partir do link em *Marca* e **fixo na tela o tempo todo** (na moldura lateral fica na barra de baixo; na tela cheia fica num cartão embaixo da webcam). Se preferir que ele apareça só de tempos em tempos, desmarque "QR sempre na tela" e defina o intervalo.
- **Prévia:** mostra a moldura de cada jogo antes de mexer no OBS.
- **Montar cenas no OBS:** cria, para cada jogo, **duas cenas** (ex.: `CS2` para o lobby e `CS2 Jogo` para a partida, com captura do jogo, webcam, moldura e alertas) e as telas *Começando*, *Já volto* e *Encerrando*. Só cria ou atualiza fontes com nome começando por `LC `, nunca apaga nada e pula cenas que já têm itens seus. "Ver o que será criado" mostra o plano sem alterar nada.
- A captura do jogo usa o modo "qualquer tela cheia". Se o seu jogo roda em janela, abra as Propriedades da fonte `LC Jogo ...` no OBS e escolha a janela.

Fontes de navegador (o app já cria sozinho, mas se precisar manualmente):
- Moldura: `http://localhost:3000/overlays/frame.html?game=cs2` (1920x1080; troque `cs2` por `lol` ou `ronrun`)
- Alertas: `http://localhost:3000/overlays/alerts.html` (1920x1080)
- Telas: `http://localhost:3000/overlays/screen.html?type=starting&min=5` (também `brb` e `ending`)
- Metas: `http://localhost:3000/overlays/goals.html`
- Chat avulso: `http://localhost:3000/overlays/chat.html`

## Fase da partida: lobby ⇄ partida (aba Controle > "Fase da partida")
O app troca sozinho entre a cena do lobby e a da partida. Três botões mandam sobre isso:
- **⚙️ Automático:** o app detecta o início e o fim da partida.
- **🏠 Lobby** e **🎮 Em partida:** forçam uma das telas (use se a detecção falhar, ou para jogos sem detecção).

Como cada jogo é detectado (aba Visual > "Webcam na partida e detecção de cada jogo"):
- **CS2:** integração oficial da Valve (Game State Integration). Na aba Visual, clique em **Instalar no CS2** (ou baixe o arquivo e copie para `game/csgo/cfg`) e **reinicie o CS2 uma vez**. O CS2 passa a avisar o app quando um mapa começa e termina.
- **LoL:** automático, sem instalar nada. O app usa a API local que o próprio jogo abre durante a partida (`127.0.0.1:2999`). No client, sem partida, fica no lobby.
- **Pelo programa aberto:** considera "em partida" enquanto um programa (.exe) estiver aberto. Para jogos que só abrem durante a partida.
- **Só pelos botões:** sem detecção. É o padrão do Ron Run até você informar o programa.

Regras: a partida só é confirmada depois de ~6 segundos (evita piscar por uma falha pontual) e o app **só troca de cena se você estiver numa das cenas daquele jogo**, então não atrapalha a pausa ("Já volto") nem as telas de começo e fim. Ao clicar num jogo em "Jogo", o app já vê se há partida em andamento.

## Perfis de jogo (aba Perfis)
Um clique no jogo faz, de uma vez: troca a cena, ajusta volumes, liga/desliga fontes (ex.: minimapa), muda as cores dos overlays e atualiza o **título e a categoria na Twitch**. O painel mostra quais passos deram certo (✔) e quais falharam (✘).
- Volumes: uma linha por fonte, em dB (`Mic/Aux=-6`).
- Fontes: `Minimapa=off` ou `Cena>Fonte=on`.
- **Já volto:** muta o microfone, troca para a cena de pausa e, ao voltar, devolve a cena anterior.

## Twitch (aba Twitch e Bot)
1. Em https://dev.twitch.tv/console/apps clique em **Registrar sua aplicação**: nome qualquer (ex.: Live Control), URL de redirecionamento OAuth `http://localhost`, categoria *Application Integration*, tipo de cliente **Público**.
2. Abra a aplicação criada e copie o **ID do cliente**. (Não precisa de segredo.)
3. Coloque o ID do cliente em `config.json` > `twitch.clientId` (e o seu canal em `twitch.channel`). No painel (aba Twitch e Bot), clique em **Conectar Twitch**, abra o link mostrado, digite o código e autorize. Se o canal ainda estiver como `seucanal`, o app passa a usar o da conta que você conectou.
4. Depois de conectar: alertas de follow, sub, raid e bits em tempo real, título e categoria dos perfis, e o bot responde no chat.
O token fica em `data/twitch.json`. Não compartilhe essa pasta.

## LivePix
Crie uma aplicação na LivePix e coloque `clientId` e `clientSecret` em `config.json` > `livepix`, e o seu link em `brand.livepixUrl`. O app consulta as doações a cada ~6 segundos (sem webhook e sem endereço público), dispara o alerta, atualiza as metas e agradece no chat (se a Twitch estiver conectada).
**Cuidado:** o `config.json` guarda o segredo da LivePix em texto puro. Ele já está no `.gitignore`; nunca o suba para o Git.
Doações de outras fontes (ex.: n8n) podem entrar por `POST /api/donation` com `{"name","amount","message"}`.

## Ações do chat (aba Ações do chat)
"Quando acontecer X, faça Y." Gatilhos: **recompensa de pontos do canal**, **doação** (com faixa de valor), **bits**, **follow**, **inscrição**, **renovação**, **presente de subs**, **raid**, **comando no chat** (!sirene, com restrição a todos, subs, VIPs ou só mods), **vitória** e **derrota**. Ações: **tocar som**, **texto grande na tela**, **cartão de aviso**, **trocar de cena por alguns segundos** (e voltar sozinho), **falar no chat**, **anúncio no chat** e **marcar clipe**. Nos textos use `{user}`, `{amount}`, `{reward}` e `{input}`.
- Cada ação tem **recuo** (segundos de espera para disparar de novo) e um botão **Testar**. No teste, mensagens no chat e anúncios **não são enviados**.
- **Recompensas de pontos:** o nome da recompensa na ação precisa ser igual ao da Twitch. Na própria aba dá para listar as recompensas do canal e criar novas (só afiliado ou parceiro). As que o app cria já concluem o resgate sozinhas; as que você criou no painel da Twitch ficam na sua fila de resgates e você limpa por lá (a Twitch só deixa o app que criou a recompensa gerenciar a fila dela).
- Já vêm prontas: sirene e buzina por recompensa, doações média e grande, vitória, derrota e o comando !sirene (desligado).
- Para o app perceber recompensas, bits etc., a Twitch precisa estar conectada com as permissões novas (clique em Desconectar e Conectar de novo uma vez).

## Placar da sessão (Controle > Placar, e na tela da live)
- Botões **Vitória**, **Derrota**, **Desfazer** e **Zerar**, com aproveitamento, sequência e a quebra por jogo.
- **Contagem automática:** no **CS2**, o app compara o placar do seu time no fim do mapa (integração do CS2 instalada); no **LoL**, usa o evento de fim de partida da API do jogo. Dá para desligar ("Contar sozinho").
- Aparece na **moldura** (barra de baixo no lobby; escolha "sempre" na aba Visual para aparecer também na partida) e como overlay avulso: `http://localhost:3000/overlays/score.html` (use `?game=cs2` para mostrar só um jogo).
- "Zerar sessão" (aba Metas) também zera o placar.

## Mixer de áudio (Controle > Mixer de áudio)
Sliders de volume (em dB) e botão de mudo para cada fonte de áudio do OBS, com **medidores ao vivo**. Mexer no OBS reflete no painel e vice-versa. "Escolher fontes" esconde as que você não quer ver. **Salvar no jogo** guarda os volumes atuais no perfil do jogo ativo (eles voltam ao clicar no jogo). Dá para destacar o mixer numa janela pequena (↗).

## Cortes mais completos (aba Clipes)
- **Marcação automática:** no CS2, a partir de 3 kills no round (Triple, Quadra, ACE; a marcação sobe de nível sozinha); no LoL, multi-kills seus (a partir de 3); doações a partir de R$ X; raids; chat acima de N mensagens por minuto. Cada regra liga, desliga ou muda o mínimo. Zero desliga a regra.
- **Cortar todos** (16:9, vertical ou os dois): fila com barra de progresso; só corta o que ainda não foi cortado. Cada marcação pode ter seu próprio tempo antes e depois.
- **Clipe na Twitch agora** e, opcionalmente, um clipe oficial a cada marcação automática (vem desligado, porque cria clipes de verdade no seu canal). Precisa da live no ar.
- **Abrir pasta** dos clipes, apagar marcações e ver quais foram marcadas sozinhas.

## Anúncios (aba Anúncios)
- **Anúncios no chat:** mensagens destacadas na Twitch, com cor (cor do canal, azul, verde, laranja ou roxo). Cada anúncio salvo vira um botão aqui e na aba Controle. Você também pode digitar e enviar um na hora, e criar botões do tipo `announce` (com o nome do anúncio) em "Botões".
- **Intervalo comercial (ads):** roda um anúncio de 30 a 180 segundos, mostra quando vem o próximo e permite adiar. A opção "Avisar o chat" manda uma mensagem quando o anúncio começa. Só funciona para afiliados e parceiros da Twitch. Botão do tipo `ad` aceita os segundos.
- Os escopos novos (`moderator:manage:announcements`, `channel:edit:commercial`, `channel:read:ads`) são pedidos ao conectar a Twitch. Se você já tinha conectado antes, clique em Desconectar e Conectar de novo.

## Visão geral (aba Visão geral)
Espectadores, tempo no ar, seguidores, subs, mensagens por minuto, próximo anúncio, título e categoria atuais, últimos eventos (doações, follows, subs, raids, bits, anúncios) e quem mais fala. Espectadores, seguidores e subs precisam da Twitch conectada; eventos e quem mais fala funcionam sempre.

## Janelas separadas (destacar abas e blocos)
- **Destacar aba:** o botão "↗ Destacar aba" no topo abre a aba atual numa janela só dela (ex.: o chat pequeno, ao lado do jogo).
- **Destacar bloco:** o "↗" ao lado do título de cada bloco (Jogo, Botões, Anúncios, Transmissão, Fila de alertas, Sessão e metas, Saúde da live, Eventos, Quem mais fala...) abre só aquele bloco.
- Endereços diretos: `http://localhost:3000/?view=chat`, `?view=overview`, `?view=ads`, `?view=control&w=alerts` (qualquer aba ou bloco).
- **Sempre no topo:** o navegador não segura a janela por cima do jogo. Use o PowerToys (Win + Ctrl + T) ou o recurso "Always on top" de qualquer gerenciador de janelas.
- **Dentro do OBS:** em Docas > Docas de navegador personalizadas, adicione um endereço acima (ex.: o chat) e ele vira um painel do próprio OBS.

## Bot de chat
- **Comandos** (`!pix`, `!discord`...) com recuo por comando. Use `{user}` na resposta.
- **Mensagens automáticas** a cada X minutos, só com a live no ar e depois de pelo menos Y mensagens no chat.

## Cortes (aba Clipes)
- "Marcar agora" guarda o tempo da live, o jogo atual e salva o replay do OBS. Dê nome ao momento.
- Exporte a lista em CSV ou texto.
- **Cortar 16:9 / Vertical (9:16):** usa a gravação do OBS (se estiver gravando) ou o replay. Precisa do **ffmpeg**: `winget install Gyan.FFmpeg` (reinicie o app). Os arquivos ficam em `data/clips/`.
- **Texto:** sugestão de título, descrição e hashtags para YouTube e TikTok.
- Antes da live: ligue a **gravação** e o **buffer de replay** no OBS.

## Efeitos sonoros (aba Sons e bloco "Efeitos sonoros" no Controle)
- Já vêm 10 efeitos **sintéticos e livres de direitos**: sirene de polícia, sirene rápida, buzina de ar, "FAH" (imitação sintética, não é o áudio original do meme), erro, trombone triste, boom, ding, moeda e rimshot. Cada um já tem botão, mais um **Parar sons** (para cortar a sirene, por exemplo).
- **Seus próprios sons:** na aba Sons, envie arquivos .mp3, .wav ou .ogg (até 15 MB) ou coloque-os na pasta `sounds/`. Depois clique em **Criar botão** ao lado do som. O ▶ toca só no seu PC, para você ouvir antes.
- **Volume dos efeitos** (controle na aba Sons) vale para todos os botões.
- Para os efeitos **irem para a live**, o som sai pelo overlay de alertas no OBS. O botão "Montar cenas no OBS" já liga o *Controlar áudio via OBS* dessa fonte, e ela passa a aparecer no mixer do OBS. Se você montou a cena à mão, abra as Propriedades da fonte de navegador de alertas e marque essa opção.
- Sons de meme famosos são gravações de terceiros: coloque o seu próprio arquivo, e use por sua conta e risco quanto a direitos autorais (a Twitch pode silenciar trechos).
- Para gerar de novo os sons embutidos: `node tools/make-sounds.mjs`.
