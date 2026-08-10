import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { createRequire } from 'module';
import { mkdirSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import pino from 'pino';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const qrcodeTerminal = require('qrcode-terminal');

const AUTH_DIR     = './wa_auth_setup';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabaseUpsert(table, data) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ id: 1, ...data, updated_at: new Date().toISOString() })
    });
}

async function saveSessionToSupabase() {
    try {
        const files = readdirSync(AUTH_DIR);
        const authData = {};
        for (const file of files) {
            authData[file] = readFileSync(join(AUTH_DIR, file), 'utf8');
        }
        const sessionData = Buffer.from(JSON.stringify(authData)).toString('base64');
        await supabaseUpsert('whatsapp_session', { session_data: sessionData });
        console.log('💾 Sesión guardada en Supabase automáticamente.');
    } catch (e) {
        console.log('⚠️ No se pudo guardar sesión en Supabase:', e.message);
    }
}

async function setup() {
    console.log('🚀 Iniciando setup de sesión WhatsApp...');
    mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n👆 Escaneá el QR con WhatsApp → Dispositivos vinculados → Vincular dispositivo\n');
            qrcodeTerminal.generate(qr, { small: true });

            try {
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                await supabaseUpsert('whatsapp_setup', { qr_code: qrDataUrl, status: 'pending_qr' });
                console.log('📲 QR guardado — el barbero puede escanearlo desde el panel admin.');
            } catch (e) {
                console.log('⚠️ No se pudo guardar QR en Supabase:', e.message);
            }
        }

        if (connection === 'open') {
            console.log('\n✅ WhatsApp vinculado correctamente!');
            // Esperar que saveCreds termine de escribir todos los archivos
            await new Promise(r => setTimeout(r, 5000));
            await saveSessionToSupabase();
            await supabaseUpsert('whatsapp_setup', { qr_code: null, status: 'connected' });
            console.log('✅ Sesión guardada en Supabase. El barbero ya puede recibir recordatorios.');
            process.exit(0);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Conexión cerrada (código ${code}).`);
            await supabaseUpsert('whatsapp_setup', { qr_code: null, status: 'disconnected' });
            if (code !== DisconnectReason.loggedOut) setup();
        }
    });
}

setup().catch(err => {
    console.error('❌ Error fatal:', err.message);
    process.exit(1);
});
