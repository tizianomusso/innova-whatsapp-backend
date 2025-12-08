const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Logger silencioso para Baileys
const logger = pino({ level: 'silent' });

// Almacén de sesiones
const sessions = {};

// Directorio de sesiones
const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ============================================
// FUNCIÓN PRINCIPAL: Crear sesión de WhatsApp
// ============================================
async function createSession(empresa_id) {
  const sessionPath = path.join(SESSIONS_DIR, empresa_id);
  
  // Inicializar objeto de sesión si no existe
  if (!sessions[empresa_id]) {
    sessions[empresa_id] = {
      client: null,
      lastQr: null,
      lastQrRaw: null,
      status: 'initializing',
      user: null,
      qrRetries: 0
    };
  }
  
  try {
    // Cargar estado de autenticación
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // Obtener versión de WhatsApp Web
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[${empresa_id}] Usando WA Web v${version.join('.')}`);
    
    // Crear conexión
    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: true,
      browser: ['Innova CRM', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 60000,
    });
    
    sessions[empresa_id].client = sock;
    
    // Guardar credenciales cuando se actualicen
    sock.ev.on('creds.update', saveCreds);
    
    // ====== EVENTO PRINCIPAL: CONEXIÓN ======
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // Si hay un QR, guardarlo
      if (qr) {
        sessions[empresa_id].qrRetries++;
        sessions[empresa_id].status = 'qr_ready';
        sessions[empresa_id].lastQrRaw = qr;
        
        // Convertir a base64 para el frontend
        try {
          const qrBase64 = await QRCode.toDataURL(qr, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          });
          sessions[empresa_id].lastQr = qrBase64;
          console.log(`[${empresa_id}] ✅ QR generado (intento ${sessions[empresa_id].qrRetries})`);
        } catch (err) {
          console.error(`[${empresa_id}] Error generando QR:`, err);
        }
      }
      
      // Conexión abierta (autenticado!)
      if (connection === 'open') {
        sessions[empresa_id].status = 'connected';
        sessions[empresa_id].lastQr = null;
        sessions[empresa_id].lastQrRaw = null;
        sessions[empresa_id].qrRetries = 0;
        sessions[empresa_id].user = {
          id: sock.user?.id,
          name: sock.user?.name || sock.user?.verifiedName || 'Usuario',
          phone: sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0]
        };
        console.log(`[${empresa_id}] ✅ CONECTADO como ${sessions[empresa_id].user.name} (${sessions[empresa_id].user.phone})`);
      }
      
      // Conexión cerrada
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`[${empresa_id}] Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);
        
        if (shouldReconnect) {
          sessions[empresa_id].status = 'reconnecting';
          setTimeout(() => createSession(empresa_id), 3000);
        } else {
          sessions[empresa_id].status = 'disconnected';
          sessions[empresa_id].client = null;
          sessions[empresa_id].lastQr = null;
          sessions[empresa_id].user = null;
          
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${empresa_id}] Sesión eliminada`);
          }
        }
      }
    });
    
    // ====== MENSAJES ENTRANTES ======
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        
        const messageBody = 
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '[Media]';
        
        console.log(`[${empresa_id}] 📩 Mensaje de ${msg.pushName || msg.key.remoteJid}: ${messageBody.substring(0, 50)}...`);
      }
    });
    
    return sock;
    
  } catch (error) {
    console.error(`[${empresa_id}] Error creando sesión:`, error);
    sessions[empresa_id].status = 'error';
    sessions[empresa_id].error = error.message;
    throw error;
  }
}

// ============================================
// ENDPOINTS REST API
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Innova WhatsApp Backend',
    version: '2.0.0',
    sessions: Object.keys(sessions).length,
    timestamp: new Date().toISOString()
  });
});

// Crear/iniciar sesión
app.post('/whatsapp/sessions', async (req, res) => {
  const { empresa_id } = req.body;
  
  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }
  
  if (sessions[empresa_id]?.status === 'connected') {
    return res.json({
      status: 'already_connected',
      empresa_id,
      user: sessions[empresa_id].user
    });
  }
  
  if (sessions[empresa_id]?.lastQr && sessions[empresa_id]?.status === 'qr_ready') {
    return res.json({
      status: 'qr_ready',
      empresa_id,
      qr: sessions[empresa_id].lastQr
    });
  }
  
  try {
    console.log(`[${empresa_id}] Iniciando nueva sesión...`);
    await createSession(empresa_id);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    return res.json({
      status: sessions[empresa_id].status,
      empresa_id,
      qr: sessions[empresa_id].lastQr,
      user: sessions[empresa_id].user
    });
    
  } catch (error) {
    console.error(`[${empresa_id}] Error:`, error);
    
    if (sessions[empresa_id]?.lastQr) {
      return res.json({
        status: 'qr_ready',
        empresa_id,
        qr: sessions[empresa_id].lastQr,
        warning: error.message
      });
    }
    
    return res.status(500).json({ 
      error: 'Error creando sesión',
      details: error.message 
    });
  }
});

// Obtener estado de sesión
app.get('/whatsapp/sessions/:empresa_id/status', (req, res) => {
  const { empresa_id } = req.params;
  
  if (!sessions[empresa_id]) {
    return res.json({
      status: 'not_found',
      empresa_id,
      exists: false
    });
  }
  
  return res.json({
    status: sessions[empresa_id].status,
    empresa_id,
    exists: true,
    connected: sessions[empresa_id].status === 'connected',
    user: sessions[empresa_id].user,
    hasQr: !!sessions[empresa_id].lastQr
  });
});

// Obtener QR (JSON con base64)
app.get('/whatsapp/sessions/:empresa_id/qr', (req, res) => {
  const { empresa_id } = req.params;
  
  if (!sessions[empresa_id]) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }
  
  if (sessions[empresa_id].status === 'connected') {
    return res.json({ 
      status: 'already_connected',
      user: sessions[empresa_id].user,
      qr: null 
    });
  }
  
  if (!sessions[empresa_id].lastQr) {
    return res.json({ 
      status: sessions[empresa_id].status,
      qr: null,
      message: 'QR aún no disponible, intentá de nuevo en unos segundos'
    });
  }
  
  return res.json({ 
    status: 'qr_ready',
    qr: sessions[empresa_id].lastQr 
  });
});

// Obtener QR como imagen PNG
app.get('/whatsapp/qr/:empresa_id', (req, res) => {
  const { empresa_id } = req.params;
  
  if (!sessions[empresa_id]?.lastQr) {
    return res.status(404).send('QR no disponible. Creá primero la sesión.');
  }
  
  const base64Data = sessions[empresa_id].lastQr.replace(/^data:image\/png;base64,/, '');
  const imgBuffer = Buffer.from(base64Data, 'base64');
  
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(imgBuffer);
});

// Obtener chats
app.get('/whatsapp/sessions/:empresa_id/chats', async (req, res) => {
  const { empresa_id } = req.params;
  
  if (!sessions[empresa_id]?.client) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }
  
  if (sessions[empresa_id].status !== 'connected') {
    return res.status(400).json({ error: 'Sesión no conectada' });
  }
  
  try {
    return res.json({ 
      message: 'Para obtener chats, usá el endpoint de mensajes o implementá almacenamiento',
      status: sessions[empresa_id].status
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Enviar mensaje
app.post('/whatsapp/sessions/:empresa_id/messages', async (req, res) => {
  const { empresa_id } = req.params;
  const { to, message } = req.body;
  
  if (!to || !message) {
    return res.status(400).json({ error: 'Se requiere "to" y "message"' });
  }
  
  if (!sessions[empresa_id]?.client) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }
  
  if (sessions[empresa_id].status !== 'connected') {
    return res.status(400).json({ error: 'Sesión no conectada' });
  }
  
  try {
    const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    
    const result = await sessions[empresa_id].client.sendMessage(jid, { text: message });
    
    console.log(`[${empresa_id}] 📤 Mensaje enviado a ${to}`);
    
    return res.json({ 
      status: 'sent',
      messageId: result.key.id,
      to: jid
    });
  } catch (error) {
    console.error(`[${empresa_id}] Error enviando mensaje:`, error);
    return res.status(500).json({ error: error.message });
  }
});

// Cerrar sesión (logout)
app.post('/whatsapp/sessions/:empresa_id/logout', async (req, res) => {
  const { empresa_id } = req.params;
  
  if (!sessions[empresa_id]?.client) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }
  
  try {
    await sessions[empresa_id].client.logout();
    console.log(`[${empresa_id}] Logout realizado`);
  } catch (e) {
    // Ignorar errores de logout
  }
  
  const sessionPath = path.join(SESSIONS_DIR, empresa_id);
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }
  
  delete sessions[empresa_id];
  
  return res.json({ status: 'logged_out', empresa_id });
});

// Listar todas las sesiones
app.get('/whatsapp/sessions', (req, res) => {
  const list = Object.entries(sessions).map(([id, session]) => ({
    empresa_id: id,
    status: session.status,
    connected: session.status === 'connected',
    user: session.user
  }));
  
  return res.json({ sessions: list });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║   🚀 Innova WhatsApp Backend v2.0                  ║
║   📡 Servidor corriendo en puerto ${port}             ║
║   🔗 Usando Baileys (sin Chrome/Puppeteer)         ║
╚════════════════════════════════════════════════════╝
  `);
});
