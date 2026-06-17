/**
 * ============================================================================
 * WebSpoffer — Módulo 2: Motor de Identidad y Almacenamiento
 * ============================================================================
 *
 * Background Script (Event Page) para Firefox MV3.
 *
 * Responsabilidades:
 *  1. PRNG determinista (Mulberry32) para generación de ruido coherente.
 *  2. Generación de perfiles de hardware/navegador coherentes por plataforma.
 *  3. Persistencia de identidad vía browser.storage.local (API de promesas).
 *  4. Rotación de identidad bajo demanda desde el popup.
 *  5. Comunicación con Content Scripts y Popup vía browser.runtime.onMessage.
 *
 * Principio de Evasión — Spoofing Coherente:
 *  Cada perfil mantiene consistencia lógica entre OS, GPU, User-Agent,
 *  oscpu y todas las variables que los rastreadores cruzan para detectar
 *  inconsistencias. Firefox-specific: incluye variables exclusivas de Gecko
 *  (oscpu, buildID) que no existen en navegadores Chromium.
 *
 * @module background
 * @version 1.0.0
 */

'use strict';

// ============================================================================
// SECCIÓN 1: PRNG — Generador Pseudo-Aleatorio Determinista (Mulberry32)
// ============================================================================

/**
 * Mulberry32 — PRNG determinista de alta calidad con período de 2^32.
 *
 * Genera números pseudo-aleatorios reproducibles a partir de una semilla
 * de 32 bits. Garantiza que el mismo seed produce SIEMPRE la misma
 * secuencia de valores.
 *
 * EVASIÓN (Anti-Tampering):
 * Si el ruido inyectado en Canvas/WebGL/AudioContext usara Math.random(),
 * cada lectura del hash produciría un valor diferente. Rastreadores como
 * CreepJS realizan lecturas múltiples del Canvas hash dentro de la misma
 * sesión: si detectan mutación, marcan "Fingerprint tampering" de
 * inmediato. Con Mulberry32, el hash es IDÉNTICO en todas las lecturas
 * porque el ruido es determinista desde el seed de sesión.
 *
 * @param {number} seed — Semilla inicial de 32 bits (unsigned).
 * @returns {Function} Función generadora que retorna float en [0, 1).
 */
function mulberry32(seed) {
  return function () {
    // Asegurar que operamos en enteros de 32 bits con signo
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;

    // Mezcla avalancha: cada bit de la semilla afecta todos los bits de salida
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    // Conversión a unsigned y normalización a [0, 1)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Genera una semilla criptográficamente segura de 32 bits.
 *
 * Este es el ÚNICO punto donde se usa aleatoriedad verdadera del sistema.
 * Todas las decisiones de perfil y ruido derivan de esta semilla vía
 * Mulberry32, garantizando determinismo total y reproducibilidad.
 *
 * Usa la Web Crypto API (crypto.getRandomValues), disponible en contextos
 * privilegiados de extensiones Firefox sin restricciones.
 *
 * @returns {number} Semilla de 32 bits sin signo [0, 2^32 - 1].
 */
function generateCryptoSeed() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0];
}

/**
 * Helper: Selección determinista de un elemento de un array.
 *
 * @param {Array} array — Array fuente (no vacío).
 * @param {Function} rng — Función PRNG (retorno de mulberry32).
 * @returns {*} Elemento seleccionado.
 */
function pickFrom(array, rng) {
  return array[Math.floor(rng() * array.length)];
}

// ============================================================================
// SECCIÓN 2: Base de Datos de Perfiles de Plataforma
// ============================================================================

/**
 * Versiones estables de Firefox para User-Agent rotation.
 *
 * Usamos versiones reales y recientes. Un UA con una versión inexistente
 * de Firefox es detectado inmediatamente por rastreadores que validan
 * contra listas conocidas de builds oficiales de Mozilla.
 *
 * EVASIÓN: Se incluyen múltiples versiones para diversificar la huella
 * sin arriesgar a usar una versión no publicada. Rango: 125–138.
 */
const FIREFOX_VERSIONS = [
  125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138,
];

/**
 * Perfiles de plataforma coherentes.
 *
 * Cada perfil define un conjunto COMPLETO de valores lógicamente
 * consistentes. La coherencia es la defensa primaria contra sistemas
 * de detección de spoofing.
 *
 * Reglas de coherencia estrictas:
 *  - Windows → GPU: ANGLE (Direct3D11), oscpu: "Windows NT 10.0..."
 *  - macOS   → GPU: nativa OpenGL/Metal, oscpu: "Intel Mac OS X..."
 *  - Linux   → GPU: Mesa / driver nativo, oscpu: "Linux x86_64"
 *
 * EVASIÓN (Anti-Lies):
 * CreepJS cruza navigator.platform, oscpu, userAgent y el renderer
 * WebGL. Si una GPU Apple aparece en un sistema con oscpu de Windows,
 * marca "Lies" y eleva la puntuación de sospecha.
 */
const PLATFORM_PROFILES = [
  // ================================================================
  // WINDOWS 10/11
  // ================================================================
  {
    id: 'windows',
    platform: 'Win32',
    oscpu: 'Windows NT 10.0; Win64; x64',
    /**
     * Template de User-Agent para Firefox en Windows.
     * Formato: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:VER.0) Gecko/20100101 Firefox/VER.0
     */
    uaTemplate: (v) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    appVersion: '5.0 (Windows)',
    productSub: '20100101',

    /**
     * Perfiles de GPU para Windows.
     *
     * Firefox en Windows usa ANGLE como backend WebGL por defecto
     * (desde ~Firefox 96+). Los renderer strings siguen el formato:
     * "ANGLE (Vendor, GPU_Model Direct3D11 vs_X_X ps_X_X, D3D11)"
     *
     * Vendor WEBGL siempre es "Google Inc. (GPU_Vendor)" con ANGLE.
     */
    gpuProfiles: [
      // ---- NVIDIA (Desktop & Laptop) ----
      {
        vendor: 'Google Inc. (NVIDIA)',
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (NVIDIA)',
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (NVIDIA)',
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (NVIDIA)',
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (NVIDIA)',
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (NVIDIA)',
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (NVIDIA)',
        renderer:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      // ---- Intel (Integrated Graphics) ----
      {
        vendor: 'Google Inc. (Intel)',
        renderer:
          'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (Intel)',
        renderer:
          'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (Intel)',
        renderer:
          'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      // ---- AMD (Desktop) ----
      {
        vendor: 'Google Inc. (AMD)',
        renderer:
          'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (AMD)',
        renderer:
          'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      {
        vendor: 'Google Inc. (AMD)',
        renderer:
          'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
    ],

    /**
     * Resoluciones de pantalla comunes en Windows.
     * dpr = devicePixelRatio (1.0 estándar, 1.25/1.5 HiDPI laptop)
     * availHeightDelta = píxeles ocupados por la barra de tareas (~40px)
     */
    screenProfiles: [
      { width: 1920, height: 1080, dpr: 1.0, availHeightDelta: 40 },
      { width: 2560, height: 1440, dpr: 1.0, availHeightDelta: 40 },
      { width: 1366, height: 768, dpr: 1.0, availHeightDelta: 40 },
      { width: 1536, height: 864, dpr: 1.25, availHeightDelta: 40 },
      { width: 1680, height: 1050, dpr: 1.0, availHeightDelta: 40 },
      { width: 3840, height: 2160, dpr: 1.5, availHeightDelta: 40 },
    ],
  },

  // ================================================================
  // macOS (Intel & Apple Silicon via Rosetta compatibility)
  // ================================================================
  {
    id: 'macos',
    platform: 'MacIntel',
    oscpu: 'Intel Mac OS X 10.15',
    /**
     * Template de User-Agent para Firefox en macOS.
     * Formato: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:VER.0) Gecko/20100101 Firefox/VER.0
     *
     * NOTA: Incluso en Apple Silicon, Firefox reporta "Intel Mac OS X"
     * por compatibilidad cuando corre bajo Rosetta o en builds universales.
     */
    uaTemplate: (v) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    appVersion: '5.0 (Macintosh)',
    productSub: '20100101',

    /**
     * Perfiles de GPU para macOS.
     *
     * Firefox en macOS usa OpenGL nativo (no ANGLE). Los renderer strings
     * corresponden directamente al driver OpenGL del SO.
     * En Apple Silicon, WebGL puede reportar "Apple M1" / "Apple M2".
     */
    gpuProfiles: [
      // ---- Intel Integrated (MacBook Air/Pro pre-2020) ----
      {
        vendor: 'Intel Inc.',
        renderer: 'Intel(R) Iris(TM) Plus Graphics 645',
      },
      {
        vendor: 'Intel Inc.',
        renderer: 'Intel(R) Iris(TM) Plus Graphics',
      },
      {
        vendor: 'Intel Inc.',
        renderer: 'Intel(R) UHD Graphics 630',
      },
      // ---- AMD Discrete (MacBook Pro 16", iMac) ----
      {
        vendor: 'ATI Technologies Inc.',
        renderer: 'AMD Radeon Pro 5500M OpenGL Engine',
      },
      {
        vendor: 'ATI Technologies Inc.',
        renderer: 'AMD Radeon Pro 5300M OpenGL Engine',
      },
      // ---- Apple Silicon ----
      { vendor: 'Apple', renderer: 'Apple M1' },
      { vendor: 'Apple', renderer: 'Apple M2' },
      { vendor: 'Apple', renderer: 'Apple M3' },
    ],

    /**
     * Resoluciones de pantalla comunes en macOS.
     * macOS usa DPR 2.0 (Retina) por defecto en la mayoría de modelos.
     * availHeightDelta = barra de menú (~25px)
     */
    screenProfiles: [
      { width: 1440, height: 900, dpr: 2.0, availHeightDelta: 25 },
      { width: 1680, height: 1050, dpr: 2.0, availHeightDelta: 25 },
      { width: 2560, height: 1600, dpr: 2.0, availHeightDelta: 25 },
      { width: 1920, height: 1080, dpr: 2.0, availHeightDelta: 25 },
      { width: 1512, height: 982, dpr: 2.0, availHeightDelta: 25 },
    ],
  },

  // ================================================================
  // LINUX (x86_64)
  // ================================================================
  {
    id: 'linux',
    platform: 'Linux x86_64',
    oscpu: 'Linux x86_64',
    /**
     * Template de User-Agent para Firefox en Linux.
     * Formato: Mozilla/5.0 (X11; Linux x86_64; rv:VER.0) Gecko/20100101 Firefox/VER.0
     */
    uaTemplate: (v) =>
      `Mozilla/5.0 (X11; Linux x86_64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    appVersion: '5.0 (X11)',
    productSub: '20100101',

    /**
     * Perfiles de GPU para Linux.
     *
     * En Linux, Firefox usa el driver OpenGL nativo:
     *  - Intel: Mesa con drivers i915/i965
     *  - NVIDIA: Driver propietario (formato "NVIDIA GeForce .../PCIe/SSE2")
     *  - AMD: Mesa RADV/radeonsi (formato "AMD Radeon ... (chipname, LLVM ...)")
     *
     * EVASIÓN: Los renderer strings de Linux son significativamente diferentes
     * a Windows (ANGLE) y macOS (OpenGL Engine). Un renderer Mesa en un
     * sistema con oscpu Windows es una detección trivial.
     */
    gpuProfiles: [
      // ---- Intel Mesa ----
      {
        vendor: 'Intel',
        renderer: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
      },
      {
        vendor: 'Intel',
        renderer: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
      },
      {
        vendor: 'Intel',
        renderer: 'Mesa Intel(R) HD Graphics 530 (SKL GT2)',
      },
      {
        vendor: 'Intel',
        renderer: 'Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)',
      },
      // ---- NVIDIA Propietario ----
      {
        vendor: 'NVIDIA Corporation',
        renderer: 'NVIDIA GeForce GTX 1650/PCIe/SSE2',
      },
      {
        vendor: 'NVIDIA Corporation',
        renderer: 'NVIDIA GeForce RTX 3060/PCIe/SSE2',
      },
      {
        vendor: 'NVIDIA Corporation',
        renderer: 'NVIDIA GeForce RTX 4070/PCIe/SSE2',
      },
      // ---- AMD Mesa (radeonsi) ----
      {
        vendor: 'X.Org',
        renderer:
          'AMD Radeon RX 580 (polaris10, LLVM 15.0.7, DRM 3.49, 6.1.0-17-amd64)',
      },
      {
        vendor: 'X.Org',
        renderer:
          'AMD Radeon RX 6600 (navi23, LLVM 16.0.6, DRM 3.54, 6.5.0-35-generic)',
      },
    ],

    /**
     * Resoluciones de pantalla comunes en Linux.
     * La mayoría de usuarios Linux usan DPR 1.0 salvo configuraciones HiDPI.
     * availHeightDelta = panel superior típico (~28px en GNOME)
     */
    screenProfiles: [
      { width: 1920, height: 1080, dpr: 1.0, availHeightDelta: 28 },
      { width: 2560, height: 1440, dpr: 1.0, availHeightDelta: 28 },
      { width: 1366, height: 768, dpr: 1.0, availHeightDelta: 28 },
      { width: 3840, height: 2160, dpr: 2.0, availHeightDelta: 28 },
      { width: 1680, height: 1050, dpr: 1.0, availHeightDelta: 28 },
    ],
  },
];

/**
 * Mapeo de zonas horarias con idiomas/locales coherentes.
 *
 * EVASIÓN (Coherencia Geográfica):
 * Si Accept-Language dice "ja,en-US;q=0.7" pero Intl.DateTimeFormat
 * resuelve timezone "America/New_York", CreepJS detecta inconsistencia
 * geográfica. Este mapeo garantiza que timezone ↔ idioma ↔ locale
 * sean lógicamente compatibles.
 *
 * Formato del campo `lang`:
 * Cadena Accept-Language HTTP estándar (RFC 7231), con quality values.
 * Firefox envía esto exactamente como aparece aquí en las cabeceras HTTP.
 */
const TIMEZONE_LOCALE_MAP = [
  // ---- Anglófonos: América del Norte ----
  {
    timezone: 'America/New_York',
    lang: 'en-US,en;q=0.5',
    languages: ['en-US', 'en'],
  },
  {
    timezone: 'America/Chicago',
    lang: 'en-US,en;q=0.5',
    languages: ['en-US', 'en'],
  },
  {
    timezone: 'America/Denver',
    lang: 'en-US,en;q=0.5',
    languages: ['en-US', 'en'],
  },
  {
    timezone: 'America/Los_Angeles',
    lang: 'en-US,en;q=0.5',
    languages: ['en-US', 'en'],
  },
  // ---- Anglófonos: Europa / Oceanía ----
  {
    timezone: 'Europe/London',
    lang: 'en-GB,en;q=0.5',
    languages: ['en-GB', 'en'],
  },
  {
    timezone: 'Australia/Sydney',
    lang: 'en-AU,en;q=0.5',
    languages: ['en-AU', 'en'],
  },
  {
    timezone: 'America/Toronto',
    lang: 'en-CA,en;q=0.5',
    languages: ['en-CA', 'en'],
  },
  // ---- Europeos ----
  {
    timezone: 'Europe/Berlin',
    lang: 'de-DE,de;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['de-DE', 'de', 'en-US', 'en'],
  },
  {
    timezone: 'Europe/Paris',
    lang: 'fr-FR,fr;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['fr-FR', 'fr', 'en-US', 'en'],
  },
  {
    timezone: 'Europe/Madrid',
    lang: 'es-ES,es;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['es-ES', 'es', 'en-US', 'en'],
  },
  {
    timezone: 'Europe/Rome',
    lang: 'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['it-IT', 'it', 'en-US', 'en'],
  },
  {
    timezone: 'Europe/Amsterdam',
    lang: 'nl-NL,nl;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['nl-NL', 'nl', 'en-US', 'en'],
  },
  // ---- Asia ----
  {
    timezone: 'Asia/Tokyo',
    lang: 'ja,en-US;q=0.7,en;q=0.3',
    languages: ['ja', 'en-US', 'en'],
  },
  {
    timezone: 'Asia/Shanghai',
    lang: 'zh-CN,zh;q=0.9,en-US;q=0.7,en;q=0.3',
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
  },
  {
    timezone: 'Asia/Seoul',
    lang: 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.3',
    languages: ['ko-KR', 'ko', 'en-US', 'en'],
  },
  // ---- América Latina ----
  {
    timezone: 'America/Sao_Paulo',
    lang: 'pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['pt-BR', 'pt', 'en-US', 'en'],
  },
  {
    timezone: 'America/Mexico_City',
    lang: 'es-MX,es;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['es-MX', 'es', 'en-US', 'en'],
  },
  {
    timezone: 'America/Argentina/Buenos_Aires',
    lang: 'es-AR,es;q=0.9,en-US;q=0.7,en;q=0.5',
    languages: ['es-AR', 'es', 'en-US', 'en'],
  },
];

/**
 * Valores realistas de hardwareConcurrency.
 *
 * NOTA CRÍTICA FIREFOX:
 * navigator.deviceMemory NO existe en Firefox (es una API exclusiva
 * de Chromium). Inyectar esta propiedad en el navigator crearía una
 * propiedad nueva que CreepJS detectaría como "Trash" o evidencia
 * de manipulación. Por esta razón, el perfil NO incluye deviceMemory.
 */
const HARDWARE_CONCURRENCY_VALUES = [2, 4, 6, 8, 12, 16];

// ============================================================================
// SECCIÓN 3: Motor de Generación de Perfiles Coherentes
// ============================================================================

/**
 * Genera un perfil de identidad completo, coherente e indivisible.
 *
 * El perfil es la unidad atómica de identidad. Todos los módulos
 * (red, inyección, monkey patching) consumen el MISMO perfil para
 * presentar una identidad unificada al mundo exterior.
 *
 * Arquitectura de selección en cascada:
 *  1. Plataforma (OS) → determina oscpu, UA template, pool de GPUs
 *  2. GPU → seleccionada del pool de la plataforma (coherencia HW)
 *  3. Firefox Version → aplicada al UA template
 *  4. Screen → seleccionada del pool de la plataforma (DPR coherente)
 *  5. Timezone + Locale → coherencia geográfica
 *  6. Sub-semillas de ruido → derivadas del seed principal
 *
 * Cada paso usa el MISMO PRNG con la misma semilla, garantizando que
 * el mismo seed SIEMPRE genera el mismo perfil exacto.
 *
 * @param {number} seed — Semilla criptográfica de 32 bits (unsigned).
 * @returns {Object} Perfil completo de identidad para la sesión.
 */
function generateProfile(seed) {
  const rng = mulberry32(seed);

  // ---- Paso 1: Selección de plataforma (raíz de coherencia) ----
  const platform = pickFrom(PLATFORM_PROFILES, rng);

  // ---- Paso 2: Versión de Firefox ----
  const ffVersion = pickFrom(FIREFOX_VERSIONS, rng);

  // ---- Paso 3: GPU coherente con la plataforma ----
  const gpu = pickFrom(platform.gpuProfiles, rng);

  // ---- Paso 4: Pantalla coherente con la plataforma ----
  const screen = pickFrom(platform.screenProfiles, rng);

  // ---- Paso 5: Hardware concurrency ----
  const cores = pickFrom(HARDWARE_CONCURRENCY_VALUES, rng);

  // ---- Paso 6: Timezone y locale (coherencia geo-lingüística) ----
  const locale = pickFrom(TIMEZONE_LOCALE_MAP, rng);

  // ---- Paso 7: Construir User-Agent desde el template ----
  const userAgent = platform.uaTemplate(ffVersion);

  // ---- Paso 8: Derivar sub-semillas para módulos de ruido ----
  // Cada módulo de ruido (Canvas, WebGL, Audio) recibe su propia
  // sub-semilla derivada del PRNG principal. Esto garantiza que:
  //  a) El ruido es determinista e independiente por módulo
  //  b) Cambiar el ruido de Canvas no afecta el de WebGL
  //  c) Múltiples lecturas del mismo módulo dan el mismo resultado
  const canvasNoiseSeed = (rng() * 0xffffffff) >>> 0;
  const webglNoiseSeed = (rng() * 0xffffffff) >>> 0;
  const audioNoiseSeed = (rng() * 0xffffffff) >>> 0;
  const fontNoiseSeed = (rng() * 0xffffffff) >>> 0;

  // ---- Construcción del perfil atómico ----
  return {
    // ==== Metadatos de sesión ====
    sessionSeed: seed,
    platformId: platform.id,
    firefoxVersion: ffVersion,
    createdAt: Date.now(),
    isActive: true,

    // ==== Navigator Properties (Module 5: Monkey Patcher) ====
    // Estas propiedades serán inyectadas vía Object.defineProperty
    // en el prototipo de Navigator del Main World.
    navigator: {
      userAgent,
      platform: platform.platform,
      oscpu: platform.oscpu,
      /**
       * buildID fijo "20181001000000" desde Firefox 64.
       * Mozilla lo congeló por privacidad para evitar fingerprinting
       * por versión exacta del build. Todos los Firefox legítimos
       * modernos reportan este valor exacto al contenido web.
       * (Extensiones pueden ver el real vía browser.runtime, pero
       * las páginas web siempre ven el valor fijo.)
       */
      buildID: '20181001000000',
      appVersion: platform.appVersion,
      product: 'Gecko',
      productSub: platform.productSub,
      hardwareConcurrency: cores,
      language: locale.languages[0],
      languages: [...locale.languages], // Clon para evitar mutación externa
      doNotTrack: 'unspecified',
      maxTouchPoints: 0, // Desktop = 0 (touch sería 1-10)
      // ⚠️ navigator.deviceMemory: NO INCLUIDA.
      // Firefox no implementa esta API. Crearla sería detectable.
    },

    // ==== WebGL Renderer Info (Module 5: Monkey Patcher) ====
    // Retornadas por WEBGL_debug_renderer_info extension:
    //  - getParameter(37445) → UNMASKED_VENDOR_WEBGL
    //  - getParameter(37446) → UNMASKED_RENDERER_WEBGL
    webgl: {
      vendor: gpu.vendor,
      renderer: gpu.renderer,
    },

    // ==== Screen Properties (Module 5: Monkey Patcher) ====
    // Sobreescritas vía Object.defineProperty en window.screen
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: screen.height - screen.availHeightDelta,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: screen.dpr,
    },

    // ==== Locale y Timezone (Modules 3 y 5) ====
    // Module 3: acceptLanguage se inyecta en cabeceras HTTP
    // Module 5: timezone se usa para spoofear Intl.DateTimeFormat
    //
    // PARCHE DE COHERENCIA GEO-TEMPORAL:
    // Calculamos el offset dinámicamente usando Intl.DateTimeFormat
    // con la timezone seleccionada, así el offset respeta DST.
    // También generamos el string GMT±XXXX y el nombre legible
    // del timezone para que Date.prototype.toString sea coherente.
    locale: (function () {
      const tz = locale.timezone;
      const lang = locale.lang;

      // ---- Calcular offset dinámico (respeta DST) ----
      // Creamos un Date "ahora" y comparamos su representación
      // en UTC vs en la timezone del perfil para obtener la
      // diferencia en minutos.
      let timezoneOffset = 0;
      try {
        const now = new Date();
        const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
        const tzStr = now.toLocaleString('en-US', { timeZone: tz });
        const utcDate = new Date(utcStr);
        const tzDate = new Date(tzStr);
        // getTimezoneOffset devuelve positivo para OESTE de UTC
        timezoneOffset = Math.round((utcDate - tzDate) / 60000);
      } catch (e) {
        // Fallback: offset 0 (UTC) si falla
        timezoneOffset = 0;
      }

      // ---- Formatear string GMT±XXXX ----
      const sign = timezoneOffset > 0 ? '-' : '+';
      const absMinutes = Math.abs(timezoneOffset);
      const hours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
      const mins = String(absMinutes % 60).padStart(2, '0');
      const timezoneGMT = 'GMT' + sign + hours + mins;

      // ---- Obtener nombre legible del timezone ----
      // Usamos Intl.DateTimeFormat con timeZoneName:'long' para
      // extraer el nombre humano (ej: "Eastern Standard Time").
      let timezoneName = tz;
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          timeZoneName: 'long',
        }).formatToParts(new Date());
        const namePart = parts.find(function (p) {
          return p.type === 'timeZoneName';
        });
        if (namePart) timezoneName = namePart.value;
      } catch (e) {
        // Fallback: usar el IANA ID directamente
      }

      return {
        timezone: tz,
        timezoneOffset: timezoneOffset,
        timezoneGMT: timezoneGMT,
        timezoneName: timezoneName,
        acceptLanguage: lang,
      };
    })(),

    // ==== Sub-semillas de Ruido Determinista (Module 5) ====
    // El Monkey Patcher usa cada sub-semilla para crear una instancia
    // independiente de Mulberry32 que genera ruido en los LSB de los
    // datos de Canvas, WebGL readPixels y AudioContext.
    noise: {
      canvas: canvasNoiseSeed,
      webgl: webglNoiseSeed,
      audio: audioNoiseSeed,
      font: fontNoiseSeed,
    },
  };
}

// ============================================================================
// SECCIÓN 4: Gestión de Almacenamiento Persistente
// ============================================================================

/** Clave de almacenamiento en browser.storage.local */
const STORAGE_KEY = 'spoofProfile';

/**
 * Carga el perfil almacenado desde browser.storage.local.
 *
 * NOTA FIREFOX: browser.storage.local.get() retorna una Promesa
 * nativa. No se requiere polyfill ni callbacks.
 *
 * @returns {Promise<Object|null>} Perfil almacenado o null si no existe.
 */
async function loadProfile() {
  try {
    const data = await browser.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || null;
  } catch (error) {
    console.error('[WebSpoffer] Error cargando perfil desde storage:', error);
    return null;
  }
}

/**
 * Persiste el perfil actual en browser.storage.local.
 *
 * La persistencia garantiza que el perfil sobrevive al cierre
 * del navegador y a la suspensión del event page. Solo se genera
 * un nuevo perfil cuando el usuario lo solicita explícitamente
 * (rotación) o en la primera instalación.
 *
 * @param {Object} profile — Perfil a persistir.
 * @returns {Promise<void>}
 */
async function saveProfile(profile) {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: profile });
  } catch (error) {
    console.error('[WebSpoffer] Error guardando perfil en storage:', error);
    throw error;
  }
}

/**
 * Inicializa o carga el perfil de identidad.
 *
 * Flujo de decisión:
 *  1. forceNew = true  → Genera perfil nuevo (rotación de identidad)
 *  2. No hay perfil    → Genera perfil nuevo (primera ejecución)
 *  3. Perfil existente → Carga desde storage (sesión continua)
 *
 * @param {boolean} forceNew — Forzar generación de perfil nuevo.
 * @returns {Promise<Object>} Perfil de identidad activo.
 */
async function initializeProfile(forceNew = false) {
  let profile = null;

  if (!forceNew) {
    profile = await loadProfile();
  }

  if (!profile) {
    // Generar nuevo perfil con semilla criptográfica fresca
    const seed = generateCryptoSeed();
    profile = generateProfile(seed);
    await saveProfile(profile);

    console.log(
      `[WebSpoffer] ✓ Nuevo perfil generado:\n` +
        `  → Plataforma: ${profile.platformId}\n` +
        `  → Firefox: ${profile.firefoxVersion}\n` +
        `  → GPU: ${profile.webgl.renderer}\n` +
        `  → Cores: ${profile.navigator.hardwareConcurrency}\n` +
        `  → Timezone: ${profile.locale.timezone}\n` +
        `  → Idioma: ${profile.navigator.language}\n` +
        `  → Pantalla: ${profile.screen.width}×${profile.screen.height} @${profile.screen.devicePixelRatio}x\n` +
        `  → Seed: 0x${profile.sessionSeed.toString(16).toUpperCase().padStart(8, '0')}`
    );
  } else {
    console.log(
      `[WebSpoffer] ✓ Perfil existente cargado:\n` +
        `  → Plataforma: ${profile.platformId} | FF/${profile.firefoxVersion}\n` +
        `  → Creado: ${new Date(profile.createdAt).toLocaleString()}\n` +
        `  → Activo: ${profile.isActive}`
    );
  }

  return profile;
}

// ============================================================================
// SECCIÓN 5: Ciclo de Vida del Event Page y Comunicación
// ============================================================================

/**
 * Cache en memoria del perfil activo.
 *
 * El perfil se mantiene en RAM para acceso instantáneo cuando
 * un Content Script envía GET_PROFILE. Evita latencia de I/O
 * en cada solicitud de inyección.
 *
 * NOTA: En Firefox, los event pages pueden suspenderse tras
 * inactividad. Cuando el script se reactiva, la IIFE al final
 * de este archivo re-carga el perfil desde storage.
 */
let currentProfile = null;

/**
 * Evento: onInstalled
 * Se dispara al instalar o actualizar la extensión.
 */
browser.runtime.onInstalled.addListener(async (details) => {
  switch (details.reason) {
    case 'install':
      // Primera instalación: generar perfil inicial
      currentProfile = await initializeProfile(true);
      console.log('[WebSpoffer] ✓ Extensión instalada correctamente.');
      break;

    case 'update':
      // Actualización: mantener perfil existente para no romper sesiones
      currentProfile = await initializeProfile(false);
      console.log(
        `[WebSpoffer] ✓ Actualizada a v${browser.runtime.getManifest().version}`
      );
      break;

    default:
      currentProfile = await initializeProfile(false);
      break;
  }
});

/**
 * Evento: onStartup
 * Se dispara cada vez que el navegador arranca.
 * Carga el perfil persistido en la sesión anterior.
 */
browser.runtime.onStartup.addListener(async () => {
  currentProfile = await initializeProfile(false);
});

/**
 * Sistema de mensajería centralizado.
 *
 * Protocolo de comunicación entre componentes:
 *
 *  ┌─────────────┐   GET_PROFILE    ┌──────────────┐
 *  │Content Script│ ──────────────→  │              │
 *  └─────────────┘  ←────────────── │  Background  │
 *                    {profile}       │   (Este      │
 *  ┌─────────────┐  ROTATE_IDENTITY │   Archivo)   │
 *  │   Popup     │ ──────────────→  │              │
 *  └─────────────┘  ←────────────── │              │
 *                    {profile,       └──────────────┘
 *                     rotated:true}
 *
 * TODOS los handlers retornan Promesas (estándar browser.* de Firefox).
 * El listener retorna la Promesa directamente para que el runtime
 * la resuelva y envíe la respuesta al remitente.
 */
browser.runtime.onMessage.addListener((message, sender) => {
  switch (message.type) {
    case 'GET_PROFILE':
      return handleGetProfile();

    case 'ROTATE_IDENTITY':
      return handleRotateIdentity();

    case 'TOGGLE_ACTIVE':
      return handleToggleActive();

    case 'GET_STATUS':
      return handleGetStatus();

    default:
      // Mensaje no reconocido: no responder (return undefined)
      // Esto permite que otros listeners manejen el mensaje.
      return false;
  }
});

// ============================================================================
// SECCIÓN 6: Handlers de Mensajes
// ============================================================================

/**
 * GET_PROFILE — Solicitado por el Content Script (Module 4).
 *
 * El Content Script necesita el perfil completo para inyectar
 * la configuración de spoofing en el Main World antes de que
 * el primer script de la página se ejecute.
 *
 * @returns {Promise<{profile: Object}>}
 */
async function handleGetProfile() {
  if (!currentProfile) {
    currentProfile = await initializeProfile(false);
  }
  return { profile: currentProfile };
}

/**
 * ROTATE_IDENTITY — Solicitado por el Popup (Module 6).
 *
 * Genera un perfil completamente nuevo con una semilla criptográfica
 * fresca. Después de la rotación, el popup recarga la pestaña activa
 * para aplicar la nueva identidad.
 *
 * La rotación NO invalida perfiles en pestañas ya cargadas. Solo
 * las pestañas recargadas recibirán la nueva identidad.
 *
 * @returns {Promise<{profile: Object, rotated: boolean}>}
 */
async function handleRotateIdentity() {
  currentProfile = await initializeProfile(true);

  return {
    profile: currentProfile,
    rotated: true,
  };
}

/**
 * TOGGLE_ACTIVE — Solicitado por el Popup (Module 6).
 *
 * Activa o desactiva el spoofing globalmente.
 * Cuando isActive=false, los Content Scripts y el módulo webRequest
 * deben dejar de interceptar (comportamiento pass-through).
 *
 * @returns {Promise<{isActive: boolean}>}
 */
async function handleToggleActive() {
  if (!currentProfile) {
    currentProfile = await initializeProfile(false);
  }

  currentProfile.isActive = !currentProfile.isActive;
  await saveProfile(currentProfile);

  console.log(
    `[WebSpoffer] Spoofing ${currentProfile.isActive ? '🟢 ACTIVADO' : '🔴 DESACTIVADO'}`
  );

  return { isActive: currentProfile.isActive };
}

/**
 * GET_STATUS — Solicitado por el Popup (Module 6).
 *
 * Retorna el estado completo para el panel de telemetría:
 * estado de activación + perfil actual con todos sus datos.
 *
 * @returns {Promise<{isActive: boolean, profile: Object|null}>}
 */
async function handleGetStatus() {
  if (!currentProfile) {
    currentProfile = await initializeProfile(false);
  }

  return {
    isActive: currentProfile.isActive,
    profile: currentProfile,
    rfpDetection: rfpDetectionResult || { detected: false, signals: [] },
  };
}

// ============================================================================
// SECCIÓN 7.5: Detección de privacy.resistFingerprinting (Módulo 7)
// ============================================================================
//
// Firefox tiene su propio mecanismo anti-fingerprinting activable via
// about:config → privacy.resistFingerprinting = true.
//
// Cuando RFP está activo, Firefox aplica AGRESIVAMENTE:
//   - Redondeo de performance.now() a ≥2ms
//   - Timezone forzado a UTC
//   - Canvas → datos uniformes (blanco)
//   - Screen → valores genéricos (900x600 o similar)
//   - UA string modificada
//
// COLISIÓN: Nuestro Monkey Patcher (Módulo 5) sobreescribe prototipos
// que RFP también modifica. El resultado son valores CONTRADICTORIOS:
//   - Nuestro navigator.userAgent dice "Windows 10"
//   - Pero RFP fuerza screen a 900x600 (valor genérico)
//   → CreepJS detecta incoherencia → "Lies"
//
// HEURÍSTICA DE DETECCIÓN (sin permisos extra):
//   Signal 1: performance.now() — tomamos 30 muestras y verificamos
//     si alguna tiene precisión sub-milisegundo. RFP redondea a ≥2ms.
//   Signal 2: Timezone forzado a UTC — Intl.DateTimeFormat retorna
//     'UTC' cuando RFP está activo, independientemente del OS.
//
// Ejecutamos la detección UNA VEZ al inicio y cacheamos el resultado.
// El popup lo lee via GET_STATUS.
// ============================================================================

/** Cache del resultado de detección de RFP */
let rfpDetectionResult = null;

/**
 * Detecta si privacy.resistFingerprinting está activo en Firefox.
 *
 * NO requiere permisos adicionales. RFP afecta TODOS los contextos
 * del navegador, incluyendo extension background pages.
 *
 * @returns {{ detected: boolean, signals: string[] }}
 */
function detectResistFingerprinting() {
  const result = { detected: false, signals: [] };

  // ---- Signal 1: Precisión de performance.now() ----
  //
  // Sin RFP: performance.now() retorna valores con sub-ms precision
  //   Ejemplo: 12345.678901
  //
  // Con RFP: Firefox redondea a ≥2ms (sin componente fraccional)
  //   Ejemplo: 12346.0
  //
  // Tomamos 30 muestras con busy loops intermedios para asegurar
  // que el tiempo avance. Si NINGUNA muestra tiene parte fraccional,
  // es un fuerte indicador de RFP.
  try {
    const samples = [];
    for (let i = 0; i < 30; i++) {
      samples.push(performance.now());
      // Busy loop para avanzar el reloj entre muestras
      let x = 0;
      for (let j = 0; j < 2000; j++) x += Math.sqrt(j);
    }

    // Verificar si alguna muestra tiene componente fraccional
    const hasSubMsPrecision = samples.some((val) => {
      const fractional = val - Math.floor(val);
      return fractional > 0.0001 && fractional < 0.9999;
    });

    if (!hasSubMsPrecision && samples.length > 1) {
      // Verificación adicional: los deltas deben ser múltiplos de 2
      const deltas = [];
      for (let i = 1; i < samples.length; i++) {
        const delta = samples[i] - samples[i - 1];
        if (delta > 0) deltas.push(delta);
      }

      const allMultiplesOf2 =
        deltas.length > 0 && deltas.every((d) => d % 2 === 0 || d === 0);

      if (allMultiplesOf2) {
        result.signals.push('performance.now() redondeado a ≥2ms');
      } else {
        result.signals.push(
          'performance.now() sin precisión sub-milisegundo'
        );
      }
    }
  } catch (e) {
    // performance.now() no disponible (improbable en Firefox)
  }

  // ---- Signal 2: Timezone forzado a UTC ----
  //
  // Sin RFP: Intl.DateTimeFormat().resolvedOptions().timeZone retorna
  //   el timezone real del OS (ej: "America/New_York")
  //
  // Con RFP: Firefox fuerza a "UTC" independientemente del OS.
  //
  // NOTA: Usuarios en UK/Portugal/etc. podrían tener UTC legítimo.
  // Por eso combinamos con Signal 1 para mayor confianza.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = new Date().getTimezoneOffset();

    // Si el timezone es UTC Y el offset del Date también es 0,
    // podría ser legítimo O podría ser RFP.
    if (tz === 'UTC' && offset === 0) {
      result.signals.push('Timezone forzado a UTC');
    }
  } catch (e) {
    // Intl no disponible (improbable en Firefox moderno)
  }

  // ---- Resultado final ----
  // Consideramos RFP detectado si hay AL MENOS 1 señal.
  // Con 2 señales, la confianza es muy alta.
  result.detected = result.signals.length > 0;

  return result;
}

// Ejecutar detección al cargar el background script
rfpDetectionResult = detectResistFingerprinting();
if (rfpDetectionResult.detected) {
  console.warn(
    '[WebSpoffer] ⚠️ privacy.resistFingerprinting detectado:',
    rfpDetectionResult.signals.join(', ')
  );
}

// ============================================================================
// SECCIÓN 7.6: Auto-Inicialización del Event Page
// ============================================================================
//
// Garantiza que el perfil esté disponible en memoria lo antes posible,
// cubriendo el caso donde el event page se reactiva por un evento
// (no por onStartup ni onInstalled).

(async () => {
  if (!currentProfile) {
    try {
      currentProfile = await initializeProfile(false);
    } catch (error) {
      console.error('[WebSpoffer] Error en auto-inicialización:', error);
    }
  }
})();

// ============================================================================
// SECCIÓN 8: Interceptación de Tráfico de Red (Módulo 3)
// ============================================================================
//
// Este módulo intercepta TODAS las solicitudes HTTP/HTTPS salientes
// y sobreescribe cabeceras de identificación para que coincidan con
// el perfil de identidad activo.
//
// ARQUITECTURA DE RENDIMIENTO:
//
//   ┌──────────────┐   User-Agent     ┌────────────────────────┐
//   │  HTTP Request │ ──────────────→  │ webRequest.onBefore... │
//   │  (Browser)    │  Accept-Language │ (blocking listener)    │
//   └──────────────┘                   │                        │
//                                      │ Lee: currentProfile    │
//                                      │ (variable en RAM)      │
//                                      │                        │
//                                      │ ❌ NO lee storage      │
//                                      │ ❌ NO hace await       │
//                                      │ ❌ NO toca el DOM      │
//                                      └────────────────────────┘
//
// EVASIÓN:
// NO se inyectan cabeceras Sec-CH-UA* porque Firefox no las envía
// de forma nativa. Enviar Client Hints desde un User-Agent que dice
// ser Firefox es una detección trivial en cualquier WAF o sistema
// anti-bot. Además, se eliminan defensivamente si alguna otra
// extensión las inyecta accidentalmente.
// ============================================================================

/**
 * Handler de webRequest.onBeforeSendHeaders.
 *
 * Modifica cabeceras HTTP ANTES de que salgan del navegador.
 * Ejecución síncrona (blocking) — cero latencia de I/O.
 *
 * @param {Object} details — Detalles de la solicitud HTTP.
 * @param {Array}  details.requestHeaders — Cabeceras HTTP de la solicitud.
 * @returns {{ requestHeaders: Array }} Cabeceras modificadas.
 */
function handleBeforeSendHeaders(details) {
  // ---- Fast exit: sin perfil o spoofing desactivado ----
  // No modificar las cabeceras, dejar pasar la request original.
  // Esto ocurre brevemente durante el arranque (antes de que el
  // perfil se cargue desde storage) y cuando el usuario desactiva
  // el spoofing desde el popup.
  if (!currentProfile || !currentProfile.isActive) {
    return { requestHeaders: details.requestHeaders };
  }

  const headers = details.requestHeaders;

  // Recorrido INVERSO: permite splice() sin desajustar índices.
  // Más eficiente que crear un nuevo array con filter().
  let i = headers.length;
  while (i--) {
    const name = headers[i].name.toLowerCase();

    switch (name) {
      // ---- Cabeceras que SOBREESCRIBIMOS ----

      case 'user-agent':
        // Sincronización red↔JS: esta cabecera debe ser IDÉNTICA
        // al valor que navigator.userAgent retorna en el Main World.
        // Cualquier discrepancia es detectable trivialmente.
        headers[i].value = currentProfile.navigator.userAgent;
        break;

      case 'accept-language':
        // Coherencia con navigator.language y navigator.languages.
        // Firefox envía el Accept-Language exactamente como está
        // configurado en about:preferences#general → Idiomas.
        // El valor del perfil simula esta configuración.
        headers[i].value = currentProfile.locale.acceptLanguage;
        break;

      // ---- Cabeceras que ELIMINAMOS defensivamente ----
      //
      // Firefox NO envía Client Hints (Sec-CH-UA*) de forma nativa.
      // Si estas cabeceras aparecen, es porque otra extensión las
      // inyectó o alguna configuración experimental las habilitó.
      //
      // Eliminarlas proactivamente evita:
      //  1. Que un WAF detecte Client Hints en un UA de Firefox ("Lies")
      //  2. Que un anti-bot cruce las CH con el UA y encuentre incoherencia
      //  3. Que la presencia de CH delate que algo manipula las cabeceras
      //
      case 'sec-ch-ua':
      case 'sec-ch-ua-mobile':
      case 'sec-ch-ua-platform':
      case 'sec-ch-ua-platform-version':
      case 'sec-ch-ua-arch':
      case 'sec-ch-ua-bitness':
      case 'sec-ch-ua-model':
      case 'sec-ch-ua-full-version-list':
      case 'sec-ch-ua-wow64':
        headers.splice(i, 1);
        break;
    }
  }

  return { requestHeaders: headers };
}

/**
 * Registro del listener con capacidad de bloqueo síncrono.
 *
 * Firefox MV3 mantiene soporte COMPLETO para webRequest bloqueante.
 * A diferencia de Chrome (que lo eliminó en MV3 en favor de
 * declarativeNetRequest), Firefox permite que las extensiones
 * intercepten y modifiquen headers en tiempo real.
 *
 * ExtraInfoSpec:
 *  - 'blocking': El browser espera nuestra respuesta antes de enviar
 *    la request. Esto es CRÍTICO para que el servidor remoto reciba
 *    el UA spoofed, no el real.
 *  - 'requestHeaders': Nos da acceso al array de cabeceras para
 *    lectura y modificación.
 */
browser.webRequest.onBeforeSendHeaders.addListener(
  handleBeforeSendHeaders,
  { urls: ['<all_urls>'] },
  ['blocking', 'requestHeaders']
);

console.log(
  '[WebSpoffer] ✓ Módulo 3 activo: Interceptor de cabeceras HTTP (webRequest blocking)'
);
