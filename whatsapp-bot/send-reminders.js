import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_CONFIG = JSON.parse(readFileSync(join(__dirname, '..', 'client-config.json'), 'utf8'));

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const REPO_WA       = process.env.REPO_WA || '';
const AUTH_DIR      = '/tmp/wa_auth';
const COUNTRY_CODE  = CLIENT_CONFIG.countryCode;
const BARBERIA_NAME = CLIENT_CONFIG.barberiaName;

function getSiteUrl() {
    if (!REPO_WA) return '';
    const [org, repo] = REPO_WA.split('/');
    return `https://${org}.github.io/${repo}/`;
}

function buildCancelToken(id, phone) {
    const last4 = String(phone || '').replace(/\D/g, '').slice(-4).padStart(4, '0');
    return Buffer.from(`${id}:${last4}`).toString('base64');
}

function getTodayARG() {
    const d = new Date().toLocaleString('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return d;
}

async function loadSessionFiles() {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_session?id=eq.1&select=session_data`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const rows = await resp.json();
    if (!rows.length || !rows[0].session_data)
        throw new Error('No hay sesión guardada. Escaneá el QR desde el panel admin.');
    const files = JSON.parse(Buffer.from(rows[0].session_data, 'base64').toString('utf8'));
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
    const siteUrl = getSiteUrl();
    let cancelLine = '';
    if (siteUrl && b.id && b.client_phone) {
        const token = buildCancelToken(b.id, b.client_phone);
        cancelLine = `\n\n❌ Si no podés venir, cancelá acá:\n${siteUrl}cancel.html?token=${token}`;
    }
    return (
        `¡Hola ${nombre}! 👋\n\n` +
        `Te recordamos que hoy tenés turno en *${BARBERIA_NAME}*:\n\n` +
        `🕐 Hora: ${b.time}\n` +
        `✂️ Servicio: ${b.service_name}\n` +
        `👤 Barbero: ${b.barber_name}\n\n` +
        `¡Te esperamos!` +
        cancelLine
    );
}

async function main() {
    await loadSessionFiles();

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
