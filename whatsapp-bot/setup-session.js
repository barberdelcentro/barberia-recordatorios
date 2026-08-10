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

async function updateSupabase(data) {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_setup`, {
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

async function setup() {
    console.log('🚀 Iniciando setup de sesión WhatsApp...');
    mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 Versión Baileys: ${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n👆 Escaneá el QR de abajo con WhatsApp:');
            console.log('   Configuración → Dispositivos vinculados → Vincular dispositivo\n');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('\n⏳ Esperando escaneo (tenés ~3 minutos)...');

            try {
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                await updateSupabase({ qr_code: qrDataUrl, status: 'pending_qr' });
                console.log('📲 QR guardado en Supabase — el barbero puede escanearlo desde el panel admin.');
            } catch (e) {
                console.log('⚠️ No se pudo guardar en Supabase:', e.message);
            }
        }

        if (connection === 'open') {
            console.log('\n✅ WhatsApp vinculado correctamente!\n');
            await updateSupabase({ qr_code: null, status: 'connected' });
            await new Promise(r => setTimeout(r, 2000));

            const files = readdirSync(AUTH_DIR);
            const authData = {};
            for (const file of files) {
                authData[file] = readFileSync(join(AUTH_DIR, file), 'utf8');
            }

            const b64 = Buffer.from(JSON.stringify(authData)).toString('base64');
            console.log('='.repeat(70));
            console.log('COPIÁ TODO EL TEXTO DE ABAJO Y GUARDALO EN GITHUB SECRETS → WA_SESSION');
            console.log('='.repeat(70));
            console.log(b64);
            console.log('='.repeat(70));
            process.exit(0);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Conexión cerrada (código ${code}).`);
            await updateSupabase({ qr_code: null, status: 'disconnected' });
            if (code !== DisconnectReason.loggedOut) setup();
        }
    });
}

setup().catch(err => {
    console.error('❌ Error fatal:', err.message);
    process.exit(1);
});
