let sbClient = null;
let supabaseInitError = null;

try {
    sbClient = window.createSupabaseClient();
} catch (error) {
    supabaseInitError = error;
    console.error("Error inicializando Supabase:", error);
}

function requireSupabase() {
    if (!sbClient) {
        throw new Error("Supabase no está configurado correctamente.");
    }
    return sbClient;
}

function parseCancelToken(token) {
    if (!token) return null;
    try {
        const raw = atob(token);
        const [idPart, last4] = raw.split(":");
        const bookingId = Number(idPart);
        if (!Number.isInteger(bookingId) || !last4 || last4.length !== 4) return null;
        return { bookingId, last4 };
    } catch (_error) {
        return null;
    }
}

const CANCEL_CUTOFF_HOURS = 2;

function getPhoneLast4(phone) {
    return String(phone || "").replace(/\D/g, "").slice(-4).padStart(4, "0");
}

function bookingDateTime(booking) {
    const [t, modifier] = String(booking.time || "").split(" ");
    let [h, m] = t.split(":");
    h = parseInt(h, 10);
    if (h === 12 && modifier === "AM") h = 0;
    if (h !== 12 && modifier === "PM") h += 12;
    return new Date(`${booking.date}T${String(h).padStart(2, "0")}:${String(m || "0").padStart(2, "0")}:00`);
}

function isTooClose(booking) {
    return (bookingDateTime(booking) - new Date()) < CANCEL_CUTOFF_HOURS * 60 * 60 * 1000;
}

const DB = {
    async getBookingById(id) {
        const { data, error } = await requireSupabase()
            .from("bookings")
            .select("*")
            .eq("id", id)
            .single();
        if (error) throw error;
        return data;
    },
    async cancelBookingById(id) {
        const { error } = await requireSupabase()
            .from("bookings")
            .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
            .eq("id", id);
        if (error) throw error;
    }
};

function setMessage(text, color) {
    const msg = document.getElementById("cancel-message");
    msg.textContent = text;
    msg.style.color = color || "#d1d5db";
}

function setSummary(booking) {
    const summary = document.getElementById("cancel-summary");
    summary.innerHTML = `
        <div><strong>Fecha:</strong> ${booking.date}</div>
        <div><strong>Hora:</strong> ${booking.time}</div>
        <div><strong>Servicio:</strong> ${booking.service_name || "-"}</div>
        <div><strong>Barbero:</strong> ${booking.barber_name || "-"}</div>
        <div><strong>Cliente:</strong> ${booking.client_name || "-"}</div>
    `;
    summary.style.display = "block";
}

document.addEventListener("DOMContentLoaded", async () => {
    const confirmBtn = document.getElementById("cancel-confirm-btn");
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const tokenData = parseCancelToken(token);

    if (!window.hasSupabaseConfig() || !sbClient) {
        setMessage("No se puede validar la cancelación: falta configurar Supabase.", "#fca5a5");
        console.error(supabaseInitError);
        return;
    }

    if (!tokenData) {
        setMessage("El enlace de cancelación no es válido o está incompleto.", "#fca5a5");
        return;
    }

    try {
        const booking = await DB.getBookingById(tokenData.bookingId);
        if (!booking) {
            setMessage("No se encontró la reserva para este enlace.", "#fca5a5");
            return;
        }

        if (getPhoneLast4(booking.client_phone) !== tokenData.last4) {
            setMessage("El enlace de cancelación no coincide con la reserva.", "#fca5a5");
            return;
        }

        if (booking.completed === true) {
            setMessage("Este turno ya fue marcado como realizado y no se puede cancelar.", "#fca5a5");
            setSummary(booking);
            return;
        }

        if (isTooClose(booking)) {
            setSummary(booking);
            setMessage(`No se puede cancelar con menos de ${CANCEL_CUTOFF_HOURS} horas de anticipación. Comunicate con la barbería.`, "#fca5a5");
            return;
        }

        setSummary(booking);
        setMessage("Si confirmás, se va a liberar el horario y eliminar el turno.", "#d1d5db");
        confirmBtn.style.display = "block";

        confirmBtn.addEventListener("click", async () => {
            confirmBtn.disabled = true;
            try {
                await DB.cancelBookingById(booking.id);
                setMessage("Turno cancelado correctamente.", "#86efac");
                confirmBtn.style.display = "none";
            } catch (error) {
                console.error(error);
                setMessage("No se pudo cancelar el turno. Intentá de nuevo.", "#fca5a5");
                confirmBtn.disabled = false;
            }
        });
    } catch (error) {
        console.error(error);
        setMessage("No se pudo validar el turno con este enlace.", "#fca5a5");
    }
});
