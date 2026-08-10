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

function getTodayString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function parseTime(timeStr) {
    const [t, modifier] = String(timeStr || "").split(" ");
    let [hours, minutes] = String(t || "0:0").split(":");
    hours = parseInt(hours || "0", 10);
    if (hours === 12 && modifier === "AM") hours = 0;
    if (hours !== 12 && modifier === "PM") hours += 12;
    return hours * 60 + (parseInt(minutes || "0", 10) || 0);
}

function normalizePhone(phone) {
    return String(phone || "").replace(/\D/g, "");
}

function isMissingStatusColumn(error) {
    const blob = [
        error?.message,
        error?.details,
        error?.hint,
        error?.code
    ]
        .filter(Boolean)
        .join(" | ")
        .toLowerCase();

    if (!blob.includes("status")) return false;
    return (
        blob.includes("does not exist") ||
        blob.includes("could not find") ||
        blob.includes("schema cache") ||
        blob.includes("column")
    );
}

const CANCEL_CUTOFF_HOURS = 2;

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

function isMissingCancelledAtColumn(error) {
    const blob = [
        error?.message,
        error?.details,
        error?.hint,
        error?.code
    ]
        .filter(Boolean)
        .join(" | ")
        .toLowerCase();

    if (!blob.includes("cancelled_at")) return false;
    return (
        blob.includes("does not exist") ||
        blob.includes("could not find") ||
        blob.includes("schema cache") ||
        blob.includes("column")
    );
}

const DB = {
    async getUpcomingBookings(normalizedPhone) {
        let { data, error } = await requireSupabase()
            .from("bookings")
            .select("id,date,time,service_name,barber_name,client_name,client_phone,completed,status")
            .gte("date", getTodayString())
            .eq("client_phone", normalizedPhone)
            .order("date", { ascending: true });

        if (error && isMissingStatusColumn(error)) {
            ({ data, error } = await requireSupabase()
                .from("bookings")
                .select("id,date,time,service_name,barber_name,client_name,client_phone,completed")
                .gte("date", getTodayString())
                .eq("client_phone", normalizedPhone)
                .order("date", { ascending: true }));
        }

        if (error) throw error;
        return data || [];
    },
    async cancelBookingById(id) {
        let { error } = await requireSupabase()
            .from("bookings")
            .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
            .eq("id", id);

        if (error && isMissingCancelledAtColumn(error)) {
            ({ error } = await requireSupabase()
                .from("bookings")
                .update({ status: "cancelled" })
                .eq("id", id));
        }

        if (error && isMissingStatusColumn(error)) {
            ({ error } = await requireSupabase().from("bookings").delete().eq("id", id));
        }

        if (error) throw error;
    }
};

function renderMessage(text) {
    const result = document.getElementById("my-turns-result");
    result.innerHTML = `<p class="my-turns-empty">${text}</p>`;
}

function bookingCardHtml(booking) {
    const tooClose = isTooClose(booking);
    const cancelBtn = tooClose
        ? `<button type="button" class="btn btn-secondary my-turn-cancel-btn" disabled style="opacity:0.5; cursor:default;">
               No se puede cancelar (menos de ${CANCEL_CUTOFF_HOURS}hs de anticipación)
           </button>`
        : `<button type="button" class="btn btn-primary my-turn-cancel-btn" data-booking-id="${booking.id}">
               Cancelar turno
           </button>`;
    return `
        <div class="my-turn-card">
            <div class="my-turn-main">${booking.date} - ${booking.time}</div>
            <div class="my-turn-meta"><strong>Servicio:</strong> ${booking.service_name || "-"}</div>
            <div class="my-turn-meta"><strong>Barbero:</strong> ${booking.barber_name || "-"}</div>
            <div class="my-turn-meta"><strong>Cliente:</strong> ${booking.client_name || "-"}</div>
            ${cancelBtn}
        </div>
    `;
}

async function searchMyBookings() {
    const phoneInput = document.getElementById("my-turns-phone");
    const searchBtn = document.getElementById("my-turns-search-btn");
    const result = document.getElementById("my-turns-result");
    const normalized = normalizePhone(phoneInput.value);

    if (normalized.length < 8) {
        renderMessage("Ingresá un celular válido para buscar.");
        return;
    }

    searchBtn.disabled = true;
    searchBtn.textContent = "Buscando...";

    try {
        const allUpcoming = await DB.getUpcomingBookings(normalized);
        const mine = allUpcoming
            .filter((b) => b.completed !== true && b.status !== "cancelled")
            .sort((a, b) => {
                if (a.date !== b.date) return a.date.localeCompare(b.date);
                return parseTime(a.time) - parseTime(b.time);
            });

        if (mine.length === 0) {
            renderMessage("No encontramos turnos pendientes para ese celular.");
            return;
        }

        result.innerHTML = mine.map(bookingCardHtml).join("");
        result.querySelectorAll(".my-turn-cancel-btn").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const id = String(btn.dataset.bookingId || "").trim();
                if (!id) return;
                if (!confirm("¿Querés cancelar este turno?")) return;

                btn.disabled = true;
                btn.textContent = "Cancelando...";
                try {
                    await DB.cancelBookingById(id);
                    await searchMyBookings();
                } catch (error) {
                    console.error(error);
                    alert("No se pudo cancelar el turno. Intentá de nuevo.");
                    btn.disabled = false;
                    btn.textContent = "Cancelar turno";
                }
            });
        });
    } catch (error) {
        console.error(error);
        renderMessage("No se pudo consultar los turnos. Intentá en un momento.");
    } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = "Buscar turnos";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    if (!window.hasSupabaseConfig() || !sbClient) {
        renderMessage("No se puede cargar la consulta: falta configurar Supabase.");
        console.error(supabaseInitError);
        return;
    }

    document.getElementById("my-turns-search-btn").addEventListener("click", searchMyBookings);
});
