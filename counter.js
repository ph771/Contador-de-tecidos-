// Lógica de contagem do Contador de Cangas.
// Recebe quadros em tons de cinza (Uint8Array, largura × altura) com o tempo em ms
// e devolve eventos: { tipo: 'certa' | 'certa-desfeita' | 'ignorada', t }.
// ('ignorada' = o suporte mudou, mas algo ficou atravessando a faixa; serve para avisar.)
// Só olha a área do suporte: conta quando uma peça nova fica pendurada e parada ali.
// Uma faixa em volta do suporte (o "anel") serve para não contar mão, máquina ou pessoa:
// essas coisas sempre atravessam o anel, enquanto a peça pendurada fica só dentro do suporte.
// Não depende do navegador: a mesma lógica roda no celular e nos testes com vídeo.
(function (root) {
  const PADRAO = {
    // Área do suporte em frações da imagem (0 a 1).
    suporte: { x: 0.72, y: 0.78, w: 0.28, h: 0.18 },
    limiarPixel: 25, // diferença de cinza para um pixel contar como "mexeu"
    // Certa: o suporte fica parado e com desenho diferente do que era antes.
    suporteParadoMov: 0.03, // fração máxima de pixels mexendo para considerar parado
    suporteParadoMs: 1500, // quanto tempo precisa ficar parado
    suporteMudouNcc: 0.6, // semelhança abaixo disso = peça nova no suporte
    // Peça igual pendurada em cima de outra igual quase não muda o "desenho"; mas dobra,
    // borda e volume mudam alguns pixels. Fração de pixels diferentes acima disso = mudou.
    suporteMudouDif: 0.05,
    suporteVoltouNcc: 0.85, // se voltar a ficar igual ao antigo, desfaz a certa
    suporteDesfazMs: 10000, // janela para desfazer uma certa falsa (alguém parado na frente)
    // Anel: faixa em cima e dos lados do suporte (embaixo não, porque o tecido cai para baixo).
    anelLargura: 0.35, // largura do anel, em fração do lado menor do suporte
    anelLivreDif: 0.12, // fração de pixels diferentes acima disso = tem algo atravessando
    // Se tudo (suporte e faixa) ficar parado esse tempo com a faixa diferente, aprende a cena
    // como está, sem contar. Evita ficar travado esperando para sempre.
    aceitaCenaMs: 5000,
    // Celular mexendo: quando quase a imagem toda muda de uma vez, não é peça, é a câmera.
    cameraMexeuMov: 0.45, // fração da imagem inteira mexendo
    // Volta a contar quando o movimento cai para o nível de trabalho normal (pessoa se
    // mexendo dá até ~0,25), sem exigir a cena toda parada.
    cameraParadaMov: 0.3,
    cameraParadaMs: 1500, // por quanto tempo precisa ficar nesse nível
  };

  function retangulo(area, w, h) {
    const x0 = Math.max(0, Math.round(area.x * w));
    const y0 = Math.max(0, Math.round(area.y * h));
    const x1 = Math.min(w, Math.round((area.x + area.w) * w));
    const y1 = Math.min(h, Math.round((area.y + area.h) * h));
    return { x0, y0, x1, y1 };
  }

  function recortar(img, w, r) {
    const out = new Float32Array((r.x1 - r.x0) * (r.y1 - r.y0));
    let k = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) out[k++] = img[y * w + x];
    return out;
  }

  // Semelhança de desenho entre duas imagens (correlação normalizada, -1 a 1).
  // Não muda quando a câmera só clareia ou escurece a imagem inteira.
  function semelhanca(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - ma, db = b[i] - mb;
      ab += da * db; aa += da * da; bb += db * db;
    }
    // Imagem lisa (sem desenho, ex.: camiseta de uma cor) não tem correlação definida:
    // duas lisas contam como iguais (a diferença de pixels decide), lisa x desenhada, diferentes.
    const lisaA = aa / n < 9, lisaB = bb / n < 9;
    if (lisaA || lisaB) return lisaA && lisaB ? 1 : 0;
    return ab / Math.sqrt(aa * bb);
  }

  // Índices dos pixels do anel: em cima e dos lados do suporte, fora dele.
  function indicesAnel(r, w, h, largura) {
    const m = Math.max(2, Math.round(largura * Math.min(r.x1 - r.x0, r.y1 - r.y0)));
    const x0 = Math.max(0, r.x0 - m), x1 = Math.min(w, r.x1 + m), y0 = Math.max(0, r.y0 - m);
    const idx = [];
    for (let y = y0; y < r.y1; y++) for (let x = x0; x < x1; x++) {
      if (x >= r.x0 && x < r.x1 && y >= r.y0) continue; // dentro do suporte
      idx.push(y * w + x);
    }
    return Uint32Array.from(idx);
  }
  function pegar(img, idx) {
    const out = new Float32Array(idx.length);
    for (let i = 0; i < idx.length; i++) out[i] = img[idx[i]];
    return out;
  }
  function movimentoIdx(atual, anterior, idx, limiar) {
    let mexeu = 0;
    for (let i = 0; i < idx.length; i++) if (Math.abs(atual[idx[i]] - anterior[idx[i]]) > limiar) mexeu++;
    return idx.length ? mexeu / idx.length : 0;
  }
  // Fração de pixels diferentes entre a e b, sem contar uma mudança de brilho igual em tudo.
  function diferenca(a, b, limiar) {
    const n = a.length;
    if (!n) return 0;
    let d = 0;
    for (let i = 0; i < n; i++) d += a[i] - b[i];
    d /= n;
    let dif = 0;
    for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i] - d) > limiar) dif++;
    return dif / n;
  }

  // Fração de pixels que mexeram dentro de r.
  function movimento(atual, anterior, w, r, limiar) {
    let mexeu = 0, total = 0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        total++;
        const i = y * w + x;
        if (Math.abs(atual[i] - anterior[i]) > limiar) mexeu++;
      }
    }
    return total ? mexeu / total : 0;
  }

  function criarContador(opcoes) {
    const cfg = Object.assign({}, PADRAO, opcoes || {});

    let anterior = null, largura = 0, altura = 0, rSuporte = null, idxAnel = null;
    let baseAnel = null, anelParadoDesde = null; // como o anel fica quando não tem nada passando
    let obstruidoDesde = null;
    let baseSuporte = null; // como o suporte estava da última vez que ficou parado
    let paradoDesde = null;
    let ultimaCerta = null; // { t, baseAntes } para poder desfazer
    let cameraMexendo = false, cameraParadaDesde = null;
    const leitura = { movSuporte: 0, movTotal: 0, semelhanca: 1, cameraMexendo: false, difAnel: 0, obstruido: false };
    const tudo = () => ({ x0: 0, y0: 0, x1: largura, y1: altura });

    function preparar(w, h) {
      largura = w; altura = h;
      rSuporte = retangulo(cfg.suporte, w, h);
      idxAnel = indicesAnel(rSuporte, w, h, cfg.anelLargura);
      anterior = null; baseSuporte = null; paradoDesde = null; ultimaCerta = null;
      baseAnel = null; anelParadoDesde = null;
    }

    function processar(img, w, h, t) {
      if (w !== largura || h !== altura || !rSuporte) preparar(w, h);
      const eventos = [];
      if (!anterior) { anterior = img.slice(); return eventos; }

      // ---- Celular mexendo: esquece tudo e espera a imagem parar ----
      // (a imagem toda é usada só para isso; nada fora do suporte é contado)
      const movTotal = movimento(img, anterior, w, tudo(), cfg.limiarPixel);
      leitura.movTotal = movTotal;
      if (movTotal >= cfg.cameraMexeuMov) { cameraMexendo = true; cameraParadaDesde = null; }
      if (cameraMexendo) {
        if (movTotal < cfg.cameraParadaMov) {
          if (cameraParadaDesde === null) cameraParadaDesde = t;
          if (t - cameraParadaDesde >= cfg.cameraParadaMs) cameraMexendo = false;
        } else {
          cameraParadaDesde = null;
        }
        // Referências antigas não valem mais: a câmera pode ter mudado de posição.
        baseSuporte = null; paradoDesde = null; ultimaCerta = null;
        baseAnel = null; anelParadoDesde = null; obstruidoDesde = null;
        leitura.cameraMexendo = true;
        anterior = img.slice();
        return eventos;
      }
      leitura.cameraMexendo = false;

      // ---- Anel em volta do suporte: está livre ou tem algo atravessando? ----
      const anelAgora = pegar(img, idxAnel);
      const movAnel = movimentoIdx(img, anterior, idxAnel, cfg.limiarPixel);
      if (movAnel <= cfg.suporteParadoMov) { if (anelParadoDesde === null) anelParadoDesde = t; }
      else anelParadoDesde = null;
      const anelParadoMs = anelParadoDesde === null ? 0 : t - anelParadoDesde;
      let difAnel = baseAnel ? diferenca(anelAgora, baseAnel, cfg.limiarPixel) : 0;
      // Só troca a referência do anel quando ele está parado e quase igual (acompanha a luz).
      // Algo parado de vez na frente do suporte nunca vira referência: a contagem espera.
      if (anelParadoMs >= cfg.suporteParadoMs && (!baseAnel || difAnel <= cfg.anelLivreDif)) {
        baseAnel = anelAgora; difAnel = 0;
      }
      const anelLivre = baseAnel !== null && difAnel <= cfg.anelLivreDif;

      // ---- Certa: suporte parado, diferente de antes e anel livre ----
      const movSuporte = movimento(img, anterior, w, rSuporte, cfg.limiarPixel);
      let sem = 1, difSup = 0, obstruido = false;
      if (movSuporte <= cfg.suporteParadoMov) {
        if (paradoDesde === null) paradoDesde = t;
        const paradoMs = t - paradoDesde;
        if (paradoMs >= cfg.suporteParadoMs) {
          const agora = recortar(img, w, rSuporte);
          const cenaParadaMs = Math.min(paradoMs, anelParadoMs);
          if (!baseSuporte) {
            if (anelLivre) baseSuporte = agora;
            else if (cenaParadaMs >= cfg.aceitaCenaMs) { baseSuporte = agora; baseAnel = anelAgora; }
          } else {
            sem = semelhanca(agora, baseSuporte);
            difSup = diferenca(agora, baseSuporte, cfg.limiarPixel);
            const mudou = sem < cfg.suporteMudouNcc || difSup >= cfg.suporteMudouDif;
            if (!anelLivre) {
              if (cenaParadaMs >= cfg.aceitaCenaMs) {
                // Ficou tudo parado com a faixa diferente: aprende a cena, sem contar.
                if (mudou) eventos.push({ tipo: 'ignorada', motivo: 'faixa', t });
                baseSuporte = agora; baseAnel = anelAgora;
              } else if (mudou) {
                // Mão, máquina ou pessoa ainda na frente: espera sair, sem contar
                // e sem trocar a referência do suporte.
                obstruido = true;
              }
            } else if (mudou) {
              const a = ultimaCerta && ultimaCerta.baseAntes;
              const voltou = a && t - ultimaCerta.t <= cfg.suporteDesfazMs &&
                semelhanca(agora, a) >= cfg.suporteVoltouNcc && diferenca(agora, a, cfg.limiarPixel) < cfg.suporteMudouDif;
              if (voltou) {
                // Era alguém parado na frente do suporte, e não uma peça nova.
                eventos.push({ tipo: 'certa-desfeita', t });
                ultimaCerta = null;
              } else {
                eventos.push({ tipo: 'certa', t });
                ultimaCerta = { t, baseAntes: baseSuporte };
              }
              baseSuporte = agora;
            } else {
              baseSuporte = agora; // acompanha mudanças lentas de luz
            }
          }
        }
      } else {
        paradoDesde = null;
      }

      leitura.difAnel = difAnel;
      leitura.obstruido = obstruido || (!anelLivre && baseAnel !== null);
      if (leitura.obstruido) { if (obstruidoDesde === null) obstruidoDesde = t; } else obstruidoDesde = null;
      leitura.obstruidoMs = obstruidoDesde === null ? 0 : t - obstruidoDesde;
      leitura.movSuporte = movSuporte;
      leitura.semelhanca = sem;
      leitura.difSuporte = difSup;
      leitura.suporteParado = paradoDesde !== null && t - paradoDesde >= cfg.suporteParadoMs;
      leitura.anelLivre = anelLivre;
      leitura.temReferencia = baseSuporte !== null;
      anterior = img.slice();
      return eventos;
    }

    return { processar, leitura, config: cfg, zerar: () => preparar(largura, altura) };
  }

  const api = { criarContador, PADRAO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ContadorCangas = api;
})(typeof self !== 'undefined' ? self : this);
