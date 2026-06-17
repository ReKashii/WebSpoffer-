/**
 * ============================================================================
 * WebSpoffer — Módulo 6: Popup Controller
 * ============================================================================
 *
 * Controlador de la interfaz de usuario del popup.
 * Opera exclusivamente con la API de promesas browser.* de Firefox.
 *
 * Comunicación con el Background Script:
 *   GET_STATUS       → Estado completo (isActive, profile, rfpDetection)
 *   TOGGLE_ACTIVE    → Activar/Desactivar spoofing
 *   ROTATE_IDENTITY  → Regenerar perfil con nueva semilla
 *
 * @module popup
 * @version 1.0.0
 */

'use strict';

// ============================================================================
// Referencias al DOM
// ============================================================================

const DOM = {
  // Status
  statusDot: document.getElementById('statusDot'),
  statusLabel: document.getElementById('statusLabel'),
  toggleInput: document.getElementById('toggleInput'),

  // Warning
  rfpWarning: document.getElementById('rfpWarning'),
  rfpDetail: document.getElementById('rfpDetail'),

  // Loading
  loadingState: document.getElementById('loadingState'),

  // Telemetry
  telemetryPanel: document.getElementById('telemetryPanel'),
  dataOS: document.getElementById('dataOS'),
  dataUA: document.getElementById('dataUA'),
  dataGPU: document.getElementById('dataGPU'),
  dataVendor: document.getElementById('dataVendor'),
  dataScreen: document.getElementById('dataScreen'),
  dataCores: document.getElementById('dataCores'),
  dataLang: document.getElementById('dataLang'),
  dataTZ: document.getElementById('dataTZ'),

  // Actions
  actionsBar: document.getElementById('actionsBar'),
  btnRotate: document.getElementById('btnRotate'),

  // Footer
  footerBar: document.getElementById('footerBar'),
  dataSeed: document.getElementById('dataSeed'),
};

// ============================================================================
// Estado Local
// ============================================================================

let isActive = false;
let isProcessing = false; // Previene clicks múltiples

// ============================================================================
// Renderizado de UI
// ============================================================================

/**
 * Actualiza TODA la UI con los datos del perfil.
 *
 * @param {Object} status — Respuesta de GET_STATUS
 * @param {boolean} status.isActive
 * @param {Object} status.profile
 * @param {Object} status.rfpDetection
 */
function renderUI(status) {
  const { profile, rfpDetection } = status;
  isActive = status.isActive;

  // ---- Ocultar loading, mostrar contenido ----
  DOM.loadingState.style.display = 'none';
  DOM.telemetryPanel.style.display = 'block';
  DOM.actionsBar.style.display = 'flex';
  DOM.footerBar.style.display = 'flex';

  // ---- Status indicator ----
  DOM.toggleInput.checked = isActive;

  if (isActive) {
    DOM.statusDot.classList.add('status-dot--active');
    DOM.statusLabel.classList.add('status-label--active');
    DOM.statusLabel.textContent = 'ACTIVO';
    DOM.telemetryPanel.classList.remove('panel--disabled');
  } else {
    DOM.statusDot.classList.remove('status-dot--active');
    DOM.statusLabel.classList.remove('status-label--active');
    DOM.statusLabel.textContent = 'INACTIVO';
    DOM.telemetryPanel.classList.add('panel--disabled');
  }

  // ---- Telemetry data ----
  if (profile) {
    // OS / Platform
    DOM.dataOS.textContent = profile.platformId
      ? profile.platformId.charAt(0).toUpperCase() +
        profile.platformId.slice(1)
      : '—';

    // User-Agent (truncado para el popup)
    const ua = profile.navigator?.userAgent || '—';
    DOM.dataUA.textContent = ua.length > 80 ? ua.substring(0, 77) + '...' : ua;

    // GPU Renderer
    const renderer = profile.webgl?.renderer || '—';
    DOM.dataGPU.textContent =
      renderer.length > 55 ? renderer.substring(0, 52) + '...' : renderer;

    // GPU Vendor
    DOM.dataVendor.textContent = profile.webgl?.vendor || '—';

    // Screen
    const s = profile.screen;
    if (s) {
      DOM.dataScreen.textContent =
        `${s.width}×${s.height} @ ${s.devicePixelRatio}x (${s.colorDepth}bit)`;
    }

    // Cores
    DOM.dataCores.textContent =
      profile.navigator?.hardwareConcurrency?.toString() || '—';

    // Language
    const lang = profile.locale?.acceptLanguage || profile.navigator?.language;
    DOM.dataLang.textContent = lang || '—';

    // Timezone
    DOM.dataTZ.textContent = profile.locale?.timezone || '—';

    // Seed
    if (profile.sessionSeed !== undefined) {
      DOM.dataSeed.textContent =
        '0x' + (profile.sessionSeed >>> 0).toString(16).toUpperCase().padStart(8, '0');
    }
  }

  // ---- RFP Warning (Module 7) ----
  if (rfpDetection && rfpDetection.detected) {
    DOM.rfpWarning.classList.add('warning--visible');
    const signals = rfpDetection.signals || [];
    DOM.rfpDetail.textContent =
      'privacy.resistFingerprinting activo — ' +
      signals.join('; ') +
      '. Desactívalo en about:config para evitar conflictos.';
  } else {
    DOM.rfpWarning.classList.remove('warning--visible');
  }
}

// ============================================================================
// Comunicación con Background
// ============================================================================

/**
 * Solicita el estado completo al Background Script.
 */
async function loadStatus() {
  try {
    const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
    renderUI(status);
  } catch (error) {
    DOM.loadingState.textContent = 'Error cargando perfil.';
    console.error('[WebSpoffer Popup] Error:', error);
  }
}

/**
 * Toggle: Activar/Desactivar spoofing.
 */
async function toggleActive() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const result = await browser.runtime.sendMessage({ type: 'TOGGLE_ACTIVE' });

    // Actualizar UI inmediatamente con el nuevo estado
    isActive = result.isActive;

    if (isActive) {
      DOM.statusDot.classList.add('status-dot--active');
      DOM.statusLabel.classList.add('status-label--active');
      DOM.statusLabel.textContent = 'ACTIVO';
      DOM.telemetryPanel.classList.remove('panel--disabled');
    } else {
      DOM.statusDot.classList.remove('status-dot--active');
      DOM.statusLabel.classList.remove('status-label--active');
      DOM.statusLabel.textContent = 'INACTIVO';
      DOM.telemetryPanel.classList.add('panel--disabled');
    }
  } catch (error) {
    console.error('[WebSpoffer Popup] Toggle error:', error);
    // Revert toggle visual state
    DOM.toggleInput.checked = isActive;
  } finally {
    isProcessing = false;
  }
}

/**
 * Rotate: Genera un perfil completamente nuevo y recarga la pestaña activa.
 */
async function rotateIdentity() {
  if (isProcessing) return;
  isProcessing = true;

  // Feedback visual inmediato
  DOM.btnRotate.disabled = true;
  const originalText = DOM.btnRotate.innerHTML;
  DOM.btnRotate.innerHTML = '<span class="btn__icon">⏳</span> Rotando...';

  try {
    // 1. Solicitar nueva identidad al background
    const result = await browser.runtime.sendMessage({
      type: 'ROTATE_IDENTITY',
    });

    // 2. Actualizar UI con el nuevo perfil
    if (result && result.profile) {
      renderUI({
        isActive: result.profile.isActive,
        profile: result.profile,
        rfpDetection: null, // No cambia con la rotación
      });
    }

    // 3. Recargar la pestaña activa para aplicar la nueva identidad
    try {
      const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tabs[0] && tabs[0].id) {
        await browser.tabs.reload(tabs[0].id);
      }
    } catch (tabError) {
      // Silenciar errores de tabs (páginas restringidas)
    }

    // 4. Feedback de éxito
    DOM.btnRotate.innerHTML = '<span class="btn__icon">✓</span> Rotado';
    setTimeout(() => {
      DOM.btnRotate.innerHTML = originalText;
      DOM.btnRotate.disabled = false;
    }, 1200);
  } catch (error) {
    console.error('[WebSpoffer Popup] Rotate error:', error);
    DOM.btnRotate.innerHTML = originalText;
    DOM.btnRotate.disabled = false;
  } finally {
    isProcessing = false;
  }
}

// ============================================================================
// Event Listeners
// ============================================================================

// Toggle switch
DOM.toggleInput.addEventListener('change', toggleActive);

// Rotate button
DOM.btnRotate.addEventListener('click', rotateIdentity);

// ============================================================================
// Inicialización
// ============================================================================

// Cargar estado al abrir el popup
loadStatus();
