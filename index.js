const express = require('express');
const { create } = require('@wppconnect-team/wppconnect');
const cors = require('cors');

const sessions = {}; // Guarda las sesiones por empresa_id
const app = express();

app.use(cors());
app.use(express.json());

// Crear o devolver una sesión existente
app.post('/whatsapp/sessions', async (req, res) => {
  const { empresa_id } = req.body;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es obligatorio' });
  }

  // Si ya existe la sesión
  if (sessions[empresa_id] && sessions[empresa_id].client) {
    return res.json({
      status: 'session_exists',
      empresa_id,
      qr: sessions[empresa_id].lastQr || null,
    });
  }

  try {
    console.log(`Creando nueva sesión para empresa ${empresa_id}...`);

    // Creamos el objeto base para esta empresa
    if (!sessions[empresa_id]) {
      sessions[empresa_id] = { client: null, lastQr: null };
    }

    const session = await create({
      session: empresa_id,
      /**
       * qrCode: string en base64 (data:image/png;base64,...)
       * asciiQR: QR en ascii
       * attempts: cantidad de intentos
       * urlCode: link deeplink de WhatsApp
       */
      catchQR: (qrCode, asciiQR, attempts, urlCode) => {
        console.log(`QR generado para empresa ${empresa_id}`);
        console.log('urlCode:', urlCode);
        sessions[empresa_id].lastQr = qrCode; // guardamos el base64
      },

      // 💡 Clave: que NO se auto cierre si no se escanea rápido
      autoClose: 0, // 0 = nunca se cierra automáticamente
      // Opcional: por si tu versión soporta esta opción
      // waitQrCode: 0,

      headless: true,
      useChrome: true,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    });

    sessions[empresa_id].client = session;

    return res.json({
      status: 'session_created',
      empresa_id,
      qr: sessions[empresa_id].lastQr,
    });

  } catch (error) {
    console.error('Error creating session:', error);

    // 👇 Si igual llegamos a tener un QR, lo devolvemos igual
    if (sessions[empresa_id] && sessions[empresa_id].lastQr) {
      return res.status(200).json({
        status: 'qr_pending',
        empresa_id,
        qr: sessions[empresa_id].lastQr,
        warning: 'Hubo un error (Auto Close / Failed to authenticate), pero el QR fue generado.',
      });
    }

    return res.status(500).json({ error: 'Error creating session' });
  }
});

// Obtener QR actual
app.get('/whatsapp/sessions/:empresa_id/qr', (req, res) => {
  const { empresa_id } = req.params;

  if (!sessions[empresa_id]) {
    return res.json({ qr: null });
  }

  return res.json({ qr: sessions[empresa_id].lastQr });
});

// Obtener chats
app.get('/whatsapp/sessions/:empresa_id/chats', async (req, res) => {
  const { empresa_id } = req.params;
  const session = sessions[empresa_id];

  if (!session || !session.client) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  const chats = await session.client.getAllChats();
  res.json(chats);
});

// Obtener mensajes de un chat
app.get('/whatsapp/sessions/:empresa_id/messages', async (req, res) => {
  const { empresa_id } = req.params;
  const { chat_id } = req.query;

  const session = sessions[empresa_id];
  if (!session || !session.client) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  const msgs = await session.client.getAllMessagesInChat(chat_id, true);
  res.json(msgs);
});

// Enviar mensaje
app.post('/whatsapp/sessions/:empresa_id/messages', async (req, res) => {
  const { empresa_id } = req.params;
  const { chat_id, text } = req.body;

  const session = sessions[empresa_id];

  if (!session || !session.client) {
    return res.status(404).json({ error: 'Sesión no encontrada' });
  }

  await session.client.sendText(chat_id, text);
  res.json({ status: 'sent' });
});

const port = process.env.PORT || 8080; // en Railway usamos 8080 por Dockerfile
app.listen(port, () => console.log(`WhatsApp backend running on port ${port}`));
// force redeploy
