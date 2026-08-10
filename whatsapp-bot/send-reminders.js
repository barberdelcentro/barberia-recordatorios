import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import pino from 'pino';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const WA_SESSION    = process.env.WA_SESSION;
const AUTH_DIR      = '/tmp/wa_auth';
const COUNTRY_CODE  = '54';
const BARBERIA_NAME = 'Barber del Centro';

function getTodayARG() {
    const d = new Date().toLocaleString('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return d; // formato YYYY-MM-DD
}

function loadSessionFiles() {
    if (!WA_SESSION) throw new Error('WA_SESSION no configurada en los Secrets de GitHub.');
    const files = JSON.parse(Buffer.from(WA_SESSION, 'base64').toString('utf8'));
    mkdirSync(AUTH_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(AUTH_DIR, name), content, 'utf8');
    }
    console.log('✅ Sesión cargada.');
}

async function getTodaysBookings() {
    const today = getTodayARG();
    console.log(`📅 Buscando turnos para: ${today}`);
    console.log(`🔑 SUPABASE_URL: ${SUPABASE_URL}`);
    console.log(`🔑 SUPABASE_KEY (primeros 20 chars): ${String(SUPABASE_KEY || '').slice(0, 20)}`);
    const url = `${SUPABASE_URL}/rest/v1/bookings` +
        `?date=eq.${today}` +
        `&status=neq.cancelled` +
        `&completed=eq.false` +
        `&select=id,date,time,service_name,barber_name,client_name,client_phone`;
    const resp = await fetch(url, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        }
    });
    if (!resp.ok) throw new Error(`Supabase error: ${resp.status}`);
    return resp.json();
}

function formatPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    let full = digits.startsWith(COUNTRY_CODE) ? digits : COUNTRY_CODE + digits;
    // WhatsApp Argentina: números móviles necesitan '9' después del código de país
    if (full.startsWith('54') && !full.startsWith('549')) {
        full = '549' + full.slice(2);
    }
    return `${full}@s.whatsapp.net`;
}

function buildMessage(b) {
    const nombre = b.client_name || 'cliente';
    return (
        `¡Hola ${nombre}! 👋\n\n` +
        `Te recordamos que hoy tenés turno en *${BARBERIA_NAME}*:\n\n` +
        `🕐 Hora: ${b.time}\n` +
        `✂️ Servicio: ${b.service_name}\n` +
        `👤 Barbero: ${b.barber_name}\n\n` +
        `¡Te esperamos!`
    );
}

async function main() {
    loadSessionFiles();

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    await new Promise((resolve, reject) => {
        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

            if (connection === 'open') {
                console.log('📱 WhatsApp conectado.');
                try {
                    const bookings = await getTodaysBookings();
                    console.log(`📋 ${bookings.length} turno(s) encontrados.`);

                    for (const b of bookings) {
                        if (!b.client_phone) {
                            console.log(`  ⚠️  Sin teléfono: ${b.client_name} a las ${b.time}`);
                            continue;
                        }
                        const jid = formatPhone(b.client_phone);
                        try {
                            await sock.sendMessage(jid, { text: buildMessage(b) });
                            console.log(`  ✓ Enviado a ${b.client_name} (${b.time})`);
                        } catch (e) {
                            console.log(`  ✗ Error enviando a ${b.client_name}: ${e.message}`);
                        }
                        // Pausa entre mensajes para no parecer spam
                        await new Promise(r => setTimeout(r, 2000));
                    }
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    reject(new Error('Sesión expirada. Ir a GitHub Actions → Setup → Run workflow para renovar el QR.'));
                } else {
                    reject(new Error(`Conexión cerrada (código ${code}).`));
                }
            }
        });
    });

    console.log('✅ Recordatorios enviados correctamente.');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
