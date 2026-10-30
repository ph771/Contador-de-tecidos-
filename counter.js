// Lógica de contagem do Contador de Cangas.
// Recebe quadros em tons de cinza (Uint8Array, largura × altura) com o tempo em ms
// e devolve eventos: { tipo: 'certa' | 'certa-desfeita', t }.
// Só olha a área do suporte: conta quando uma peça nova fica pendurada e parada ali.
// Não depende do navegador: a mesma lógica roda no celular e nos testes com vídeo.
(function (root) {
  const PADRAO = {
    // Área do suporte em frações da imagem (0 a 1).
    suporte: { x: 0.72, y: 0.78, w: 0.28, h: 0.18 },
    limiarPixel: 25, // diferença de cinza para um pixel contar como "mexeu"
    // Certa: o suporte fica parado e com desenho diferente do que era antes.
    suporteParadoMov: 0.03, // fração máxima de pixels mexendo para considerar parado
    suporteParadoMs: 800, // quanto tempo precisa ficar parado
    suporteMudouNcc: 0.6, // semelhança abaixo disso = peça nova no suporte
    suporteVoltouNcc: 0.85, // se voltar a ficar igual ao antigo, desfaz a certa
    suporteDesfazMs: 10000, // janela para desfazer uma certa falsa (alguém parado na frente)
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
    return ab / Math.sqrt(aa * bb + 1e-6);
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

    let anterior = null, largura = 0, altura = 0, rSuporte = null;
    let baseSuporte = null; // como o suporte estava da última vez que ficou parado
    let paradoDesde = null;
    let ultimaCerta = null; // { t, baseAntes } para poder desfazer
    let cameraMexendo = false, cameraParadaDesde = null;
    const leitura = { movSuporte: 0, movTotal: 0, semelhanca: 1, cameraMexendo: false };
    const tudo = () => ({ x0: 0, y0: 0, x1: largura, y1: altura });

    function preparar(w, h) {
      largura = w; altura = h;
      rSuporte = retangulo(cfg.suporte, w, h);
      anterior = null; baseSuporte = null; paradoDesde = null; ultimaCerta = null;
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
        leitura.cameraMexendo = true;
        anterior = img.slice();
        return eventos;
      }
      leitura.cameraMexendo = false;

      // ---- Certa: suporte parado com desenho novo ----
      const movSuporte = movimento(img, anterior, w, rSuporte, cfg.limiarPixel);
      let sem = 1;
      if (movSuporte <= cfg.suporteParadoMov) {
        if (paradoDesde === null) paradoDesde = t;
        if (t - paradoDesde >= cfg.suporteParadoMs) {
          const agora = recortar(img, w, rSuporte);
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
