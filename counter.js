// Lógica de contagem do Contador de Cangas.
// Recebe quadros em tons de cinza (Uint8Array, largura × altura) com o tempo em ms
// e devolve eventos: { tipo: 'certa' | 'errada' | 'certa-desfeita', t }.
// Não depende do navegador: a mesma lógica roda no celular e nos testes com vídeo.
(function (root) {
  const PADRAO = {
    // Áreas em frações da imagem (0 a 1).
    areas: {
      suporte: { x: 0.72, y: 0.78, w: 0.28, h: 0.18 },
      saida: { x: 0.0, y: 0.0, w: 0.1, h: 0.45 },
      ignorar: { x: 0.0, y: 0.48, w: 0.3, h: 0.52 },
    },
    limiarPixel: 25, // diferença de cinza para um pixel contar como "mexeu"
    // Certa: o suporte fica parado e com desenho diferente do que era antes.
    suporteParadoMov: 0.03, // fração máxima de pixels mexendo para considerar parado
    suporteParadoMs: 800, // quanto tempo precisa ficar parado
    suporteMudouNcc: 0.6, // semelhança abaixo disso = peça nova no suporte
    suporteVoltouNcc: 0.85, // se voltar a ficar igual ao antigo, desfaz a certa
    suporteDesfazMs: 10000, // janela para desfazer uma certa falsa (alguém parado na frente)
    // Errada: tecido grande atravessando a área de saída.
    saidaMov: 0.3, // fração de pixels mexendo na área de saída
    saidaQuadros: 2, // em quantas amostras seguidas
    intervaloMs: 3000, // depois de contar uma errada, espera esse tempo antes de contar outra
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
    return ab / Math.sqrt(aa * bb + 1e-6);
  }

  function dentro(r, x, y) {
    return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
  }

  // Fração de pixels que mexeram dentro de r, sem contar os que estão na área "ignorar".
  function movimento(atual, anterior, w, r, ignorar, limiar) {
    let mexeu = 0, total = 0;
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (ignorar && dentro(ignorar, x, y)) continue;
        total++;
        const i = y * w + x;
        if (Math.abs(atual[i] - anterior[i]) > limiar) mexeu++;
      }
    }
    return total ? mexeu / total : 0;
  }

  function criarContador(opcoes) {
    const cfg = Object.assign({}, PADRAO, opcoes || {});
    cfg.areas = Object.assign({}, PADRAO.areas, (opcoes && opcoes.areas) || {});

    let anterior = null, largura = 0, altura = 0, rs = null;
    let baseSuporte = null; // como o suporte estava da última vez que ficou parado
    let paradoDesde = null;
    let ultimaCerta = null; // { t, baseAntes } para poder desfazer
    let ultimaErrada = -Infinity;
    let saidaSeguidos = 0;
    const leitura = { movSuporte: 0, movSaida: 0, semelhanca: 1 };

    function preparar(w, h) {
      largura = w; altura = h;
      rs = {
        suporte: retangulo(cfg.areas.suporte, w, h),
        saida: retangulo(cfg.areas.saida, w, h),
        ignorar: retangulo(cfg.areas.ignorar, w, h),
      };
      anterior = null; baseSuporte = null; paradoDesde = null; ultimaCerta = null; saidaSeguidos = 0;
    }

    function processar(img, w, h, t) {
      if (w !== largura || h !== altura || !rs) preparar(w, h);
      const eventos = [];
      if (!anterior) { anterior = img.slice(); return eventos; }

      // ---- Errada: tecido grande saindo pela área de saída ----
      const movSaida = movimento(img, anterior, w, rs.saida, rs.ignorar, cfg.limiarPixel);
      saidaSeguidos = movSaida >= cfg.saidaMov ? saidaSeguidos + 1 : 0;
      if (saidaSeguidos >= cfg.saidaQuadros && t - ultimaErrada >= cfg.intervaloMs) {
        eventos.push({ tipo: 'errada', t });
        ultimaErrada = t;
        saidaSeguidos = 0;
      }

      // ---- Certa: suporte parado com desenho novo ----
      const movSuporte = movimento(img, anterior, w, rs.suporte, null, cfg.limiarPixel);
      let sem = 1;
      if (movSuporte <= cfg.suporteParadoMov) {
        if (paradoDesde === null) paradoDesde = t;
        if (t - paradoDesde >= cfg.suporteParadoMs) {
          const agora = recortar(img, w, rs.suporte);
          if (!baseSuporte) {
            baseSuporte = agora;
          } else {
            sem = semelhanca(agora, baseSuporte);
            if (sem < cfg.suporteMudouNcc) {
              const voltou = ultimaCerta && t - ultimaCerta.t <= cfg.suporteDesfazMs &&
                semelhanca(agora, ultimaCerta.baseAntes) >= cfg.suporteVoltouNcc;
              if (voltou) {
                // Era alguém parado na frente do suporte, e não uma peça nova.
                eventos.push({ tipo: 'certa-desfeita', t });
                ultimaCerta = null;
              } else {
                eventos.push({ tipo: 'certa', t });
                ultimaCerta = { t, baseAntes: baseSuporte };
              }
            }
            baseSuporte = agora; // acompanha mudanças lentas de luz
          }
        }
      } else {
        paradoDesde = null;
      }

      leitura.movSuporte = movSuporte;
      leitura.movSaida = movSaida;
      leitura.semelhanca = sem;
      anterior = img.slice();
      return eventos;
    }

    return { processar, leitura, config: cfg, zerar: () => preparar(largura, altura) };
  }

  const api = { criarContador, PADRAO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ContadorCangas = api;
})(typeof self !== 'undefined' ? self : this);
