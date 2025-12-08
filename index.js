const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const logger = pino({ level: 'info' });
const sessions = {};
const SESSIONS_DIR = './sessions';

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

async function createSession(empresa_id, retryCount = 0) {
  const sessionPath = path.join(SESSIONS_DIR, empresa_id);
  const MAX_RETRIES = 3;
  
  if (!sessions[empresa_id]) {
    sessions[empresa_id] = {
      client: null,
      lastQr: null,
      status: 'initializing',
      user: null,
      qrRetries: 0
    };
  }
  
  if (retryCount >= MAX_RETRIES) {
    console.log(`[${empresa_id}] ❌ Máximo de reintentos alcanzado`);
    sessions[empresa_id].status = 'failed';
    return null;
  }
  
  try {
    console.log(`[${empresa_id}] Iniciando sesión (intento ${retryCount + 1})...`);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    let version;
    try {
      const versionInfo = await fetchLatestBaileysVersion();
      version = versionInfo.version;
    } catch (e) {
      version = [2, 2413, 1];
    }
    console.log(`[${empresa_id}] Usando WA Web v${version.join('.')}`);
    
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: true,
      browser: ['Innova CRM', 'Chrome', '122.0.0'],
      connectTimeoutMs: 120000,
      qrTimeout: 60000,
      markOnlineOnConnect: false,
    });
    
    sessions[empresa_id].client = sock;
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log(`[${empresa_id}] Estado: ${connection || 'update'}, QR: ${qr ? 'SI' : 'NO'}`);
      
      if (qr) {
        sessions[empresa_id].qrRetries++;
        sessions[empresa_id].status = 'qr_ready';
        try {
          sessions[empresa_id].lastQr = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
          console.log(`[${empresa_id}] ✅ QR GENERADO`);
        } catch (err) {
          console.error(`[${empresa_id}] Error QR:`, err);
        }
      }
      
      if (connection === 'open') {
        sessions[empresa_id].status = 'connected';
        sessions[empresa_id].lastQr = null;
        sessions[empresa_id].user = {
          id: sock.user?.id,
          name: sock.user?.name || 'Usuario',
          phone: sock.user?.id?.split(':')[0]
        };
        console.log(`[${empresa_id}] ✅ CONECTADO`);
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[${empresa_id}] Cerrado. Código: ${statusCode}`);
        
        if (statusCode === DisconnectReason.loggedOut) {
          sessions[empresa_id].status = 'disconnected';
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        } else if (!sessions[empresa_id].lastQr && retryCount < MAX_RETRIES) {
          sessions[empresa_id].status = 'reconnecting';
          setTimeout(() => createSession(empresa_id, retryCount + 1), 5000);
        } else if (sessions[empresa_id].lastQr) {
          sessions[empresa_id].status = 'qr_ready';
        } else {
          sessions[empresa_id].status = 'failed';
        }
      }
    });
    
    return sock;
  } catch (error) {
    console.error(`[${empresa_id}] Error:`, error.message);
    sessions[empresa_id].status = 'error';
    return null;
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Innova WhatsApp Backend', version: '2.1.0' });
});

app.post('/whatsapp/sessions', async (req, res) => {
  const { empresa_id } = req.body;
  if (!empresa_id) return res.status(400).json({ error: 'empresa_id requerido' });
  
  if (sessions[empresa_id]?.status === 'connected') {
    return res.json({ status: 'already_connected', empresa_id, user: sessions[empresa_id].user });
  }
  
  if (sessions[empresa_id]?.lastQr) {
    return res.json({ status: 'qr_ready', empresa_id, qr: sessions[empresa_id].lastQr });
  }
  
  // Limpiar sesión fallida anterior
  if (sessions[empresa_id]) {
    const sessionPath = path.join(SESSIONS_DIR, empresa_id);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    delete sessions[empresa_id];
  }
  
  createSession(empresa_id, 0);
  
  // Esperar hasta 15 segundos por el QR
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (sessions[empresa_id]?.lastQr) {
      return res.json({ status: 'qr_ready', empresa_id, qr: sessions[empresa_id].lastQr });
    }
    if (sessions[empresa_id]?.status === 'connected') {
      return res.json({ status: 'connected', empresa_id, user: sessions[empresa_id].user });
    }
    if (sessions[empresa_id]?.status === 'failed') {
      return res.status(500).json({ status: 'failed', empresa_id });
    }
  }
  
  return res.json({ status: sessions[empresa_id]?.status || 'initializing', empresa_id, qr: null });
});

app.get('/whatsapp/sessions/:empresa_id/status', (req, res) => {
  const { empresa_id } = req.params;
  if (!sessions[empresa_id]) return res.json({ status: 'not_found', exists: false });
  return res.json({
    status: sessions[empresa_id].status,
    connected: sessions[empresa_id].status === 'connected',
    hasQr: !!sessions[empresa_id].lastQr,
    user: sessions[empresa_id].user
  });
});

app.get('/whatsapp/sessions/:empresa_id/qr', (req, res) => {
  const { empresa_id } = req.params;
  if (!sessions[empresa_id]) return res.status(404).json({ error: 'Sesión no encontrada' });
  return res.json({ status: sessions[empresa_id].status, qr: sessions[empresa_id].lastQr });
});

app.get('/whatsapp/qr/:empresa_id', (req, res) => {
  const { empresa_id } = req.params;
  if (!sessions[empresa_id]?.lastQr) return res.status(404).send('QR no disponible');
  const base64Data = sessions[empresa_id].lastQr.replace(/^data:image\/png;base64,/, '');
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(base64Data, 'base64'));
});

app.post('/whatsapp/sessions/:empresa_id/messages', async (req, res) => {
  const { empresa_id } = req.params;
  const { to, message } = req.body;
  if (!sessions[empresa_id]?.client || sessions[empresa_id].status !== 'connected') {
    return res.status(400).json({ error: 'No conectado' });
  }
  try {
    const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    const result = await sessions[empresa_id].client.sendMessage(jid, { text: message });
    return res.json({ status: 'sent', messageId: result.key.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.delete('/whatsapp/sessions/:empresa_id', (req, res) => {
  const { empresa_id } = req.params;
  const sessionPath = path.join(SESSIONS_DIR, empresa_id);
  if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
  delete sessions[empresa_id];
  return res.json({ status: 'deleted' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Innova WhatsApp Backend v2.1 - Puerto ${port}`);
});
