/**
 * ============================================================================
 * WebSpoffer — Módulo 4: El Puente de Inyección (Content Script) — v2
 * ============================================================================
 *
 * Content Script ejecutado bajo Xray Vision de Firefox.
 * Configurado con "run_at": "document_start" y "all_frames": true.
 *
 * CAMBIO CRÍTICO vs v1:
 *   Se eliminó el uso de `script.src` (asíncrono, vulnerable a CSP).
 *   Ahora se usa `script.textContent` para inyección SÍNCRONA del
 *   monkey patcher, garantizando ejecución bloqueante y atómica.
 *
 * ============================================================================
 * ARQUITECTURA DE INYECCIÓN (v2 — textContent síncrono)
 * ============================================================================
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                    FASE ASÍNCRONA                           │
 *   │  (Ocurre antes de CUALQUIER manipulación del DOM/Main World)│
 *   │                                                             │
 *   │  Promise.all([                                              │
 *   │    fetch('moz-extension://UUID/injector.js') → text(),      │
 *   │    browser.runtime.sendMessage('GET_PROFILE')               │
 *   │  ])                                                         │
 *   │                                                             │
 *   │  Latencia: ~0.3-0.5ms (ambas en paralelo, fetch es local)   │
 *   └─────────────────────┬───────────────────────────────────────┘
 *                         │
 *                         ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │               BLOQUE SÍNCRONO ATÓMICO                       │
 *   │      (Cero yields — ininterrumpible por el event loop)      │
 *   │                                                             │
 *   │  1. cloneInto(profile) → wrappedJSObject.__SPOOF_CONFIG__   │
 *   │  2. script.textContent = injectorCode                       │
 *   │  3. appendChild(script) → EJECUCIÓN BLOQUEANTE              │
 *   │     └─ El monkey patcher se ejecuta AQUÍ, consume config    │
 *   │  4. script.textContent = '' → Borrar código del nodo        │
 *   │  5. script.remove() → Eliminar nodo del DOM                 │
 *   │  6. delete __SPOOF_CONFIG__ → Limpiar variable global       │
 *   │                                                             │
 *   │  GARANTÍA: Cuando este bloque termina, TODAS las APIs       │
 *   │  nativas ya están hookeadas. Ningún script de la página     │
 *   │  puede haber leído la huella real.                          │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * ============================================================================
 * ¿POR QUÉ textContent Y NO script.src?
 * ============================================================================
 *
 *   script.src = 'moz-extension://...'
 *   ├── PROBLEMA 1: Fetch asíncrono — el navegador agenda la carga del
 *   │   recurso como tarea separada. Durante el gap, el parser HTML
 *   │   puede avanzar y ejecutar <script> tags del <head> de la página.
 *   ├── PROBLEMA 2: CSP — Una directiva `script-src 'self'` bloquea
 *   │   la URL moz-extension:// (origen diferente al de la página).
 *   └── PROBLEMA 3: Dependencia de onload para cleanup (asíncrono).
 *
 *   script.textContent = code
 *   ├── VENTAJA 1: appendChild() EJECUTA el código síncronamente.
 *   │   El motor JS parsea y ejecuta el textContent ANTES de retornar
 *   │   el control al caller. Cero gap.
 *   ├── VENTAJA 2: CSP — No es afectado por directivas que bloquean
 *   │   URLs externas (script-src 'self'). Solo sería bloqueado por
 *   │   políticas que requieren nonces o prohíben 'unsafe-inline'
 *   │   explícitamente (poco frecuente en la mayoría de sitios).
 *   └── VENTAJA 3: Cleanup síncrono — script.remove() inmediato,
 *       sin necesidad de onload callback.
 *
 * ============================================================================
 * MITIGACIÓN DE RACE CONDITION — 4 Capas de Defensa
 * ============================================================================
 *
 *   CAPA 1 — Velocidad del Background:
 *     El Background Script responde GET_PROFILE desde `currentProfile`
 *     (variable en RAM). Latencia IPC: ~0.1–0.5ms.
 *
 *   CAPA 2 — Fetch local paralelo:
 *     fetch('moz-extension://UUID/injector.js') lee un archivo local
 *     empaquetado en la extensión. Latencia: ~0.1ms. Se ejecuta en
 *     PARALELO con el sendMessage via Promise.all.
 *
 *   CAPA 3 — Estado del Parser en document_start:
 *     A "document_start", el parser HTML ha creado <html> pero NO ha
 *     procesado <head>. No hay <script> tags para ejecutar. El await
 *     de ~0.5ms es insuficiente para que el parser encuentre scripts.
 *
 *   CAPA 4 — Inyección Atómica:
 *     Config + código + ejecución + cleanup en un bloque síncrono.
 *     Cero yields. Cuando el bloque termina, todo está hookeado.
 *
 * ============================================================================
 * XRAY VISION — Seguridad de Firefox
 * ============================================================================
 *
 *   wrappedJSObject → Acceso al window del Main World (sin Xray)
 *   cloneInto()     → Clon estructurado seguro para cruzar la barrera
 *
 *   Config inyectada via cloneInto (INVISIBLE al DOM):
 *     - MutationObserver: NO se dispara
 *     - Object.keys(window): NO incluye __SPOOF_CONFIG__ (non-enumerable)
 *     - CreepJS "Trash": 0 puntos por esta vía
 *
 *   Monkey patcher via textContent:
 *     - Ejecución nativa en el Main World (no wrappers de exportFunction)
 *     - toString() de funciones hookeadas: controlable por el monkey patcher
 *     - Object.getOwnPropertyDescriptor: indistinguible de funciones nativas
 *
 * @module content
 * @version 2.1.0
 */

'use strict';

// ============================================================================
// Punto de Entrada Principal
// ============================================================================

(async () => {
  try {
    // ==================================================================
    // PASO 1: Resolución Paralela de Dependencias (Fase Asíncrona)
    // ==================================================================
    //
    // Ejecutamos AMBAS operaciones asíncronas en paralelo usando
    // Promise.all. Esto minimiza la ventana de tiempo total:
    //
    //   Sin paralelo:  fetch(~0.1ms) + sendMessage(~0.5ms) = ~0.6ms
    //   Con paralelo:  max(fetch, sendMessage) = ~0.5ms
    //
    // Ambas operaciones son lecturas locales (no network I/O):
    //   - fetch → lee injector.js del paquete de la extensión (local FS)
    //   - sendMessage → background responde desde RAM (currentProfile)
    //
    // NOTA: Esta es la ÚNICA fase asíncrona del flujo de inyección.
    // Todo lo que sigue (Paso 2) es 100% síncrono.
    //
    const [injectorCode, profileResponse] = await Promise.all([
      // Canal 1: Obtener el código fuente del Monkey Patcher
      // fetch() a moz-extension:// es una lectura del filesystem local
      // empaquetado en el XPI de la extensión. No pasa por la red.
      fetch(browser.runtime.getURL('injector.js')).then((r) => r.text()),

      // Canal 2: Obtener el perfil de identidad del Background Script
      // El background responde desde currentProfile (variable en RAM).
      // No accede a browser.storage.local en este camino.
      browser.runtime.sendMessage({ type: 'GET_PROFILE' }),
    ]);

    // ---- Validación de respuestas ----

    // Si no hay perfil o el spoofing está desactivado, salir silenciosamente.
    // La página se comporta exactamente como si la extensión no existiera.
    if (!profileResponse || !profileResponse.profile || !profileResponse.profile.isActive) {
      return;
    }

    // Si el código del injector está vacío o falló la lectura, no inyectar.
    // Esto previene inyectar un <script> vacío que los detectores podrían
    // registrar como anomalía.
    if (!injectorCode || injectorCode.trim().length === 0) {
      return;
    }

    const profile = profileResponse.profile;

    // ==================================================================
    // PASO 2: Bloque Síncrono Atómico de Inyección
    // ==================================================================
    //
    // ⚠️ ZONA CRÍTICA — CERO YIELDS DESDE AQUÍ HASTA EL FINAL ⚠️
    //
    // Todo el código desde aquí hasta el comentario "FIN BLOQUE ATÓMICO"
    // se ejecuta en el MISMO turno del event loop. JavaScript es
    // single-threaded: ningún script de la página, ningún timer,
    // ningún callback puede interrumpir esta secuencia.
    //
    // Orden de operaciones:
    //   [SYNC] 1. Inyectar config → Main World (via Xray Vision)
    //   [SYNC] 2. Crear <script> con textContent
    //   [SYNC] 3. appendChild → EJECUCIÓN BLOQUEANTE del monkey patcher
    //   [SYNC] 4. Esterilizar nodo (borrar textContent)
    //   [SYNC] 5. Eliminar nodo del DOM
    //   [SYNC] 6. Eliminar variable global __SPOOF_CONFIG__
    //
    // Cuando este bloque termina:
    //   ✓ Todas las APIs de fingerprinting están hookeadas
    //   ✓ No queda rastro en el DOM
    //   ✓ No queda variable global expuesta
    //   ✓ Ningún script de la página ha tenido oportunidad de ejecutar
    //

    // ---- Referencia al Main World ----
    // wrappedJSObject bypassa Xray Vision, dándonos acceso al window
    // que ven los scripts de la página.
    const mainWorld = window.wrappedJSObject;

    // ================================================================
    // 2.1: Inyectar Configuración al Main World (via Xray Vision)
    // ================================================================
    //
    // cloneInto() crea un "structured clone" seguro para cruzar la
    // barrera de seguridad Xray. Sin esto, asignar un objeto del
    // content script al Main World causa:
    //   SecurityError: "Permission denied to access property"
    //
    // EVASIÓN:
    //   Esta operación es COMPLETAMENTE INVISIBLE al DOM.
    //   No se crea ningún nodo. MutationObservers NO se disparan.
    //   La propiedad se define como non-enumerable para no aparecer
    //   en Object.keys(window) ni en for...in loops.
    //
    const clonedConfig = cloneInto(profile, mainWorld, {
      cloneFunctions: false,
      wrapReflectors: false,
    });

    Object.defineProperty(mainWorld, '__SPOOF_CONFIG__', {
      value: clonedConfig,
      writable: false,
      enumerable: false,   // Invisible en iteraciones de window
      configurable: true,  // Permite delete posterior (cleanup)
    });

    // ================================================================
    // 2.2: Inyectar Monkey Patcher via textContent (SÍNCRONO)
    // ================================================================
    //
    // MECÁNICA DE EJECUCIÓN:
    //
    //   Cuando hacemos `parent.appendChild(scriptElement)` y el script
    //   tiene `textContent` (no `src`), el motor SpiderMonkey de Firefox:
    //
    //     1. Detecta que es un script inline (textContent, no src)
    //     2. Parsea el código JavaScript del textContent
    //     3. EJECUTA el código síncronamente, BLOQUEANDO el caller
    //     4. Retorna el control a appendChild() DESPUÉS de la ejecución
    //
    //   Esto significa que cuando la línea DESPUÉS de appendChild()
    //   se ejecuta, el monkey patcher ya ha:
    //     ✓ Leído window.__SPOOF_CONFIG__
    //     ✓ Internalizado todos los valores en closures
    //     ✓ Hookeado todas las APIs de fingerprinting
    //     ✓ Redefinido Function.prototype.toString
    //
    //   No hay gap. No hay race condition. Es bloqueante.
    //
    const script = document.createElement('script');
    script.textContent = injectorCode;

    // Insertar en el DOM → EJECUCIÓN SÍNCRONA del código
    // Usamos document.documentElement (<html>) porque a document_start
    // el <head> podría no existir aún.
    const parent = document.head || document.documentElement;
    parent.appendChild(script);

    // ================================================================
    // ^^^ El monkey patcher ha TERMINADO de ejecutar en este punto ^^^
    // ================================================================

    // ================================================================
    // 2.3: Esterilización del DOM (Anti-Forensics)
    // ================================================================
    //
    // Ahora limpiamos TODA evidencia de la inyección.
    //
    // PASO CRÍTICO — Borrar textContent ANTES de remove():
    //
    //   Cuando hacemos appendChild + remove en el mismo bloque síncrono,
    //   los MutationObserver callbacks NO se han disparado aún (son
    //   microtasks que se ejecutan al final del turno del event loop).
    //
    //   Sin embargo, un MO sofisticado podría inspeccionar el nodo
    //   huérfano (referencia en el MutationRecord.addedNodes) y leer
    //   su textContent para analizar el código inyectado.
    //
    //   Al borrar textContent ANTES de remove(), el nodo que el MO
    //   inspeccione estará vacío. No hay código que analizar.
    //
    script.textContent = '';
    script.remove();

    // ================================================================
    // 2.4: Limpieza de Variable Global
    // ================================================================
    //
    // __SPOOF_CONFIG__ ya fue consumida por el monkey patcher durante
    // appendChild (paso 2.2). El monkey patcher internalizó todos los
    // valores en closures privadas. La variable global ya no es necesaria.
    //
    // Eliminarla previene que:
    //   1. Scripts de la página lean los valores del perfil
    //   2. Herramientas de análisis detecten la variable como "Trash"
    //   3. Object.getOwnPropertyNames(window) la liste
    //
    try {
      delete mainWorld.__SPOOF_CONFIG__;
    } catch (e) {
      // Fallback: si delete falla (property no configurable por alguna
      // razón), sobreescribir con undefined para borrar los datos.
      try {
        mainWorld.__SPOOF_CONFIG__ = undefined;
      } catch (e2) {
        // Silenciar — la property queda pero sin datos útiles
      }
    }

    // ================================================================
    // ✓ FIN BLOQUE SÍNCRONO ATÓMICO
    // ================================================================
    //
    // Estado del sistema en este punto:
    //
    //   DOM:
    //     ✓ Sin nodos <script> residuales
    //     ✓ Sin textContent en nodos huérfanos
    //
    //   Main World (window):
    //     ✓ __SPOOF_CONFIG__ eliminada
    //     ✓ Todas las APIs de fingerprinting hookeadas por el monkey patcher
    //     ✓ Function.prototype.toString redefinido (stealth)
    //
    //   Cabeceras HTTP (Módulo 3):
    //     ✓ User-Agent y Accept-Language spoofed independientemente
    //
    //   Coherencia:
    //     ✓ navigator.userAgent === HTTP User-Agent header
    //     ✓ navigator.language === HTTP Accept-Language primary
    //     ✓ WebGL renderer coherente con navigator.platform
    //

  } catch (error) {
    // ==================================================================
    // Manejo Silencioso de Errores en Páginas Restringidas
    // ==================================================================
    //
    // Páginas donde el content script NO puede operar:
    //
    //   about:*          → Páginas internas de Firefox
    //   moz-extension:// → Otras extensiones
    //   chrome://*       → Páginas de sistema
    //   resource://*     → Recursos internos de Gecko
    //   data:*           → Data URIs
    //   view-source:*    → Visor de código fuente
    //
    // Estas páginas no necesitan spoofing. Los errores son esperados.
    // NO loguear para evitar ruido en la consola del desarrollador.
    //
    // NOTA: Si el error ocurre por CSP estricta (nonce-based) en un
    // sitio web regular, las cabeceras HTTP (Módulo 3) siguen operando
    // correctamente. Solo el spoofing JavaScript (Módulo 5) se pierde.
  }
})();
