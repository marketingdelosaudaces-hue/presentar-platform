// ══════════════════════════════════════════
//  PresentAR — Conexión Supabase
//  Archivo de configuración y funciones
// ══════════════════════════════════════════

const SUPABASE_URL = 'https://eldiuxxqqxjpwjtrxqfg.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVsZGl1eHhxcXhqcHdqdHJ4cWZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODYwMjcsImV4cCI6MjA4OTE2MjAyN30.HX35eqm_x_Yz83gXEDZ9q8Bq9Qdwt1ZC2CgKh1NWLFA';

// ── HELPER: llamada a Supabase REST API ──
async function sbFetch(table, options = {}) {
  const {
    method = 'GET',
    filters = '',
    body = null,
    select = '*',
    single = false,
  } = options;

  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}${filters}`;
  if (single) url += '&limit=1';

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': single ? 'return=representation' : 'return=representation',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Error en Supabase');
  }

  const data = await res.json();
  return single ? data[0] : data;
}

// ══ AUTH ══

// Login
async function loginUser(email, password) {
  const users = await sbFetch('usuarios', {
    filters: `&email=eq.${encodeURIComponent(email)}&password=eq.${encodeURIComponent(password)}&activo=eq.true`,
  });
  if (!users || users.length === 0) throw new Error('Email o contraseña incorrectos');
  return users[0];
}

// Cambiar contraseña
async function changePassword(userId, newPassword) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ password: newPassword }),
  });
  return res.ok;
}

// ══ USUARIOS (ADMIN) ══

async function getAllUsers() {
  return await sbFetch('usuarios', {
    select: 'id,email,nombre,empresa,rol,activo,created_at',
    filters: '&order=created_at.desc',
  });
}

async function createUser(data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  return await res.json();
}

async function toggleUserStatus(userId, activo) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ activo }),
  });
  return res.ok;
}

// ══ TARJETAS ══

async function getTarjeta(usuarioId) {
  const cards = await sbFetch('tarjetas', {
    filters: `&usuario_id=eq.${usuarioId}`,
  });
  return cards[0] || null;
}

async function saveTarjeta(usuarioId, data) {
  const existing = await getTarjeta(usuarioId);
  if (existing) {
    // UPDATE
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tarjetas?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(data),
    });
    return await res.json();
  } else {
    // INSERT
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tarjetas`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ ...data, usuario_id: usuarioId }),
    });
    return await res.json();
  }
}

// ══ CONTACTOS ══

async function getContactos(tarjetaId) {
  return await sbFetch('contactos', {
    filters: `&tarjeta_id=eq.${tarjetaId}&order=created_at.desc`,
  });
}

async function saveContacto(tarjetaId, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/contactos`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ ...data, tarjeta_id: tarjetaId }),
  });
  return await res.json();
}

async function updateContactoEstado(contactoId, estado) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/contactos?id=eq.${contactoId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ estado }),
  });
  return res.ok;
}

async function deleteContacto(contactoId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/contactos?id=eq.${contactoId}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  return res.ok;
}

// ══ VISITAS ══

async function registrarVisita(tarjetaId, tipo = 'web') {
  const dispositivo = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' :
                      /Tablet|iPad/i.test(navigator.userAgent) ? 'tablet' : 'desktop';
  await fetch(`${SUPABASE_URL}/rest/v1/visitas`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tarjeta_id: tarjetaId, tipo, dispositivo }),
  });
}

async function getVisitas(tarjetaId) {
  return await sbFetch('visitas', {
    filters: `&tarjeta_id=eq.${tarjetaId}&order=created_at.desc`,
  });
}

async function getEstadisticas(tarjetaId) {
  const [visitas, contactos] = await Promise.all([
    getVisitas(tarjetaId),
    getContactos(tarjetaId),
  ]);

  const ahora = new Date();
  const hace30 = new Date(ahora - 30 * 24 * 60 * 60 * 1000);
  const hace7  = new Date(ahora -  7 * 24 * 60 * 60 * 1000);

  const visitas30 = visitas.filter(v => new Date(v.created_at) > hace30);
  const visitas7  = visitas.filter(v => new Date(v.created_at) > hace7);

  const qr  = visitas.filter(v => v.tipo === 'qr').length;
  const web = visitas.filter(v => v.tipo === 'web').length;

  const porDispositivo = visitas.reduce((acc, v) => {
    acc[v.dispositivo] = (acc[v.dispositivo] || 0) + 1;
    return acc;
  }, {});

  const nuevos  = contactos.filter(c => c.estado === 'new').length;
  const leidos  = contactos.filter(c => c.estado === 'read').length;

  // Visitas por día (últimos 7 días)
  const visitasPorDia = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(ahora - i * 24 * 60 * 60 * 1000);
    const label = d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' });
    const count = visitas.filter(v => {
      const vd = new Date(v.created_at);
      return vd.toDateString() === d.toDateString();
    }).length;
    visitasPorDia.push({ label, count });
  }

  return {
    total_visitas: visitas.length,
    visitas_30d: visitas30.length,
    visitas_7d: visitas7.length,
    escaneos_qr: qr,
    visitas_web: web,
    total_contactos: contactos.length,
    contactos_nuevos: nuevos,
    contactos_leidos: leidos,
    por_dispositivo: porDispositivo,
    visitas_por_dia: visitasPorDia,
    contactos,
  };
}

// ══ SESSION (localStorage) ══
function saveSession(user) {
  localStorage.setItem('presentar_user', JSON.stringify(user));
}
function getSession() {
  try { return JSON.parse(localStorage.getItem('presentar_user')); }
  catch { return null; }
}
function clearSession() {
  localStorage.removeItem('presentar_user');
}

// ══ EXPORT ──
window.PresentAR = {
  loginUser, changePassword,
  getAllUsers, createUser, toggleUserStatus,
  getTarjeta, saveTarjeta,
  getContactos, saveContacto, updateContactoEstado, deleteContacto,
  registrarVisita, getVisitas, getEstadisticas,
  saveSession, getSession, clearSession,
};

console.log('✅ PresentAR — Supabase conectado');
