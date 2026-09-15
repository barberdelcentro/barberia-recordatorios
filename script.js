// Número de WhatsApp de la barbería (código de país + número, sin + ni espacios).
// Ej: "5491112345678" para Argentina. Dejar vacío para no mostrar el botón.
const WHATSAPP_NUMBER = "";

let CLIENT_CONFIG = {
    barberiaName: "Barber Shop",
    primaryColor: "#ff1839",
    countryCode: "54",
    horarioApertura: 10,
    horarioCierre: 20
};

async function loadClientConfig() {
    try {
        const resp = await fetch("client-config.json");
        CLIENT_CONFIG = await resp.json();
    } catch (error) {
        console.error("No se pudo cargar client-config.json, se usan valores por defecto.", error);
    }
    document.documentElement.style.setProperty("--primary-color", CLIENT_CONFIG.primaryColor);
    document.title = CLIENT_CONFIG.barberiaName;
    document.querySelectorAll("[data-client-name]").forEach((el) => {
        el.textContent = CLIENT_CONFIG.barberiaName;
    });
}

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

const DB = {
    async getServices() {
        const { data, error } = await requireSupabase()
            .from("services")
            .select("id,name,price")
            .order("id", { ascending: true });
        if (error) throw error;
        return data || [];
    },

    async getBarbers() {
        const { data, error } = await requireSupabase()
            .from("barbers")
            .select("id,name,active")
            .order("id", { ascending: true });
        if (error) throw error;
        return data || [];
    },

    async getBookingsByDateBarber(date, barberId) {
        let { data, error } = await requireSupabase()
            .from("bookings")
            .select("id,time,status")
            .eq("date", date)
            .eq("barber_id", barberId)
            .or("status.is.null,status.neq.cancelled");

        if (error && isMissingStatusColumn(error)) {
            ({ data, error } = await requireSupabase()
                .from("bookings")
                .select("id,time")
                .eq("date", date)
                .eq("barber_id", barberId));
        }

        if (error) throw error;
        return data || [];
    },

    async existsClientBooking(date, time, name, phone) {
        const normalizedPhone = phone.replace(/\D/g, "");
        const normalizedName = name.trim().toLowerCase();

        let { data, error } = await requireSupabase()
            .from("bookings")
            .select("id,client_name,client_phone,status")
            .eq("date", date)
            .eq("time", time)
            .or("status.is.null,status.neq.cancelled");

        if (error && isMissingStatusColumn(error)) {
            ({ data, error } = await requireSupabase()
                .from("bookings")
                .select("id,client_name,client_phone")
                .eq("date", date)
                .eq("time", time));
        }

        if (error) throw error;

        return (data || []).some((b) => {
            const samePhone = (b.client_phone || "").replace(/\D/g, "") === normalizedPhone;
            const sameName = (b.client_name || "").trim().toLowerCase() === normalizedName;
            return samePhone || sameName;
        });
    },

    async isSlotTaken(date, time, barberId) {
        let { data, error } = await requireSupabase()
            .from("bookings")
            .select("id,status")
            .eq("date", date)
            .eq("time", time)
            .eq("barber_id", barberId)
            .or("status.is.null,status.neq.cancelled")
            .limit(1);

        if (error && isMissingStatusColumn(error)) {
            ({ data, error } = await requireSupabase()
                .from("bookings")
                .select("id")
                .eq("date", date)
                .eq("time", time)
                .eq("barber_id", barberId)
                .limit(1));
        }

        if (error) throw error;
        return (data || []).length > 0;
    },

    async addBooking(booking) {
        let { data, error } = await requireSupabase()
            .from("bookings")
            .insert([booking])
            .select("id,client_phone")
            .single();

        if (error && isMissingStatusColumn(error)) {
            const legacyBooking = { ...booking };
            delete legacyBooking.status;
            ({ data, error } = await requireSupabase()
                .from("bookings")
                .insert([legacyBooking])
                .select("id,client_phone")
                .single());
        }

        if (error) throw error;
        return data;
    },

    async seedDefaultsIfEmpty() {
        const barbers = await this.getBarbers();
        if (barbers.length === 0) {
            const { error } = await requireSupabase().from("barbers").insert([
                { name: "Juan Pérez", active: true },
                { name: "Carlos Top", active: true },
                { name: "El Maestro", active: true }
            ]);
            if (error) throw error;
        }

        const services = await this.getServices();
        if (services.length === 0) {
            const { error } = await requireSupabase().from("services").insert([
                { name: "Corte Clásico", price: 20 },
                { name: "Afeitado", price: 15 },
                { name: "Barba y Corte", price: 30 },
                { name: "Lavado", price: 10 },
                { name: "Peinado", price: 12 },
                { name: "Tratamiento", price: 25 }
            ]);
            if (error) throw error;
        }
    }
};

let state = {
    service: null,
    barber: null,
    date: null,
    time: null
};

function createCancelToken(bookingId, phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    const last4 = digits.slice(-4).padStart(4, "0");
    const raw = `${bookingId}:${last4}`;
    return btoa(raw);
}

function showError(message) {
    alert(message || "Ocurrió un error. Intentá de nuevo.");
}

async function navigateTo(screenName) {
    if (screenName === "calendar" && !state.barber) {
        alert("Primero elegí un barbero para ver horarios.");
        return;
    }

    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    const target = document.getElementById(`screen-${screenName}`);
    if (!target) return;

    target.classList.add("active");
    if (screenName === "services") await loadServices();
    if (screenName === "barbers") await loadBarbers();
    if (screenName === "calendar") initCalendar();
}

async function loadServices() {
    const grid = document.querySelector(".services-grid");
    const priceList = document.querySelector(".price-list");
    grid.innerHTML = "";
    priceList.innerHTML = "";

    try {
        const services = await DB.getServices();
        services.forEach((srv) => {
            let iconClass = "fa-scissors";
            if (srv.name.includes("Afeitado")) iconClass = "fa-user-injured";
            if (srv.name.includes("Barba")) iconClass = "fa-user-ninja";
            if (srv.name.includes("Lavado")) iconClass = "fa-star";

            const item = document.createElement("div");
            item.className = "service-item";
            item.onclick = () => selectService(item, srv);
            item.innerHTML = `
                <i class="fa-solid ${iconClass} service-icon"></i>
                <span class="service-name">${srv.name}</span>
            `;
            grid.appendChild(item);

            const row = document.createElement("div");
            row.className = "price-row";
            row.innerHTML = `<span>${srv.name.toUpperCase()}</span><span>$ ${srv.price}</span>`;
            priceList.appendChild(row);
        });
    } catch (error) {
        console.error(error);
        showError("No se pudieron cargar los servicios.");
    }
}

async function loadBarbers() {
    const container = document.getElementById("barbers-list");
    container.innerHTML = "";

    try {
        const barbers = (await DB.getBarbers()).filter((b) => b.active);
        barbers.forEach((barber) => {
            const div = document.createElement("div");
            div.className = "service-item";
            div.style.borderRadius = "10px";
            div.onclick = () => selectBarber(div, barber);
            div.innerHTML = `
                <i class="fa-solid fa-user service-icon"></i>
                <span class="service-name">${barber.name}</span>
            `;
            container.appendChild(div);
        });
    } catch (error) {
        console.error(error);
        showError("No se pudieron cargar los barberos.");
    }
}

function selectService(element, serviceObj) {
    document.querySelectorAll(".service-item").forEach((i) => i.classList.remove("selected"));
    element.classList.add("selected");
    state.service = serviceObj;
}

function selectBarber(element, barberObj) {
    document.querySelector("#barbers-list").querySelectorAll(".service-item").forEach((i) => i.classList.remove("selected"));
    element.classList.add("selected");
    state.barber = barberObj;
}

function initCalendar() {
    const grid = document.getElementById("calendar-days");
    grid.innerHTML = "";

    const today = new Date();
    const weekDays = ["D", "L", "M", "X", "J", "V", "S"];
    let firstSelectable = null;

    for (let i = 0; i < 14; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);

        const isSunday = date.getDay() === 0;
        const div = document.createElement("div");
        div.className = "day-cell" + (isSunday ? " day-disabled" : "");
        div.innerHTML = `<span class="day-letter">${weekDays[date.getDay()]}</span>${date.getDate()}`;

        const fullDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        div.dataset.date = fullDate;

        if (!isSunday) {
            div.onclick = () => selectDate(div, fullDate);
            if (!firstSelectable) firstSelectable = div;
        }

        grid.appendChild(div);
    }

    if (firstSelectable) selectDate(firstSelectable, firstSelectable.dataset.date);
}

function selectDate(element, dateStr) {
    document.querySelectorAll(".day-cell").forEach((c) => c.classList.remove("active"));
    element.classList.add("active");
    state.date = dateStr;
    state.time = null;
    generateTimeSlots();
}

async function generateTimeSlots() {
    const container = document.getElementById("time-slots");
    container.innerHTML = "";
    document.getElementById("selected-time-display").innerText = "--:--";

    if (!state.barber || !state.date) {
        container.innerHTML = '<div style="width:100%; text-align:center; color:#bbb; font-size:13px;">Elegí un barbero para ver horarios.</div>';
        return;
    }

    try {
        const bookings = await DB.getBookingsByDateBarber(state.date, state.barber.id);
        const takenSlots = bookings.map((b) => b.time);

        for (let h = CLIENT_CONFIG.horarioApertura; h <= CLIENT_CONFIG.horarioCierre; h++) {
            const period = h >= 12 ? "PM" : "AM";
            const displayH = h > 12 ? h - 12 : h;
            const timeString = `${displayH}:00 ${period}`;

            const slotDiv = document.createElement("div");
            slotDiv.className = "time-slot";
            slotDiv.innerText = timeString;

            if (takenSlots.includes(timeString)) {
                slotDiv.style.opacity = "0.3";
                slotDiv.style.textDecoration = "line-through";
                slotDiv.style.pointerEvents = "none";
            } else {
                slotDiv.onclick = () => selectTime(slotDiv, timeString);
            }
            container.appendChild(slotDiv);
        }
    } catch (error) {
        console.error(error);
        showError("No se pudo cargar la disponibilidad.");
    }
}

function selectTime(element, timeStr) {
    document.querySelectorAll(".time-slot").forEach((s) => s.classList.remove("selected"));
    element.classList.add("selected");
    state.time = timeStr;
    document.getElementById("selected-time-display").innerText = timeStr;
}

function askForDetails() {
    if (!state.service || !state.barber || !state.date || !state.time) {
        alert("Falta información para la reserva (Elige servicio, barbero, fecha y hora).");
        return;
    }

    const summary = document.getElementById("booking-summary");
    summary.innerHTML = `
        <strong>SERVICIO:</strong> ${state.service.name} ($${state.service.price})<br>
        <strong>BARBERO:</strong> ${state.barber.name}<br>
        <strong>FECHA:</strong> ${state.date}<br>
        <strong>HORA:</strong> ${state.time}
    `;
    navigateTo("details");
}

async function confirmBooking() {
    const name = document.getElementById("client-name").value.trim();
    const phone = document.getElementById("client-phone").value.trim();

    if (!name) {
        alert("Por favor ingresá tu nombre y apellido.");
        return;
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (!phone || phoneDigits.length < 8) {
        alert("Ingresá un número de celular válido (mínimo 8 dígitos).");
        document.getElementById("client-phone").focus();
        return;
    }

    try {
        const alreadyReservedForClient = await DB.existsClientBooking(state.date, state.time, name, phone);
        if (alreadyReservedForClient) {
            alert("Ya tenés ese turno en ese horario. ¡Gracias!");
            navigateTo("calendar");
            return;
        }

        const alreadyBooked = await DB.isSlotTaken(state.date, state.time, state.barber.id);
        if (alreadyBooked) {
            alert("Ese turno ya está reservado. Elegí otro horario.");
            navigateTo("calendar");
            return;
        }

        const insertedBooking = await DB.addBooking({
            date: state.date,
            time: state.time,
            barber_id: state.barber.id,
            barber_name: state.barber.name,
            service_name: state.service.name,
            client_name: name,
            client_phone: phone.replace(/\D/g, ""),
            completed: false,
            status: "confirmed"
        });

        const successMessage = document.getElementById("success-message");
        if (successMessage) {
            successMessage.innerText = `Tu turno para ${state.service.name} quedó reservado para el ${state.date} a las ${state.time}, ${name}.`;
        }

        const cancelLink = document.getElementById("cancel-booking-link");
        if (cancelLink && insertedBooking?.id) {
            const token = createCancelToken(insertedBooking.id, phone);
            cancelLink.href = `cancel.html?token=${encodeURIComponent(token)}`;
            cancelLink.style.display = "flex";
            cancelLink.style.justifyContent = "center";
            cancelLink.style.alignItems = "center";
            cancelLink.style.borderRadius = "999px";
        }


        navigateTo("success");
    } catch (error) {
        console.error(error);
        const errorText = String(error?.message || "").toLowerCase();
        if (errorText.includes("duplicate key") || errorText.includes("bookings_unique_slot")) {
            alert("Ese turno ya fue tomado recién. Elegí otro horario.");
            navigateTo("calendar");
            return;
        }
        showError("No se pudo guardar la reserva. Revisá la conexión.");
    }
}

function startNewBooking() {
    location.reload();
}

function startCarousel() {
    const container = document.querySelector(".carousel-container");
    if (!container) return;

    setInterval(() => {
        const item = container.querySelector("img");
        if (!item) return;

        const itemWidth = item.clientWidth;
        const maxScroll = container.scrollWidth - container.clientWidth;
        if (container.scrollLeft >= maxScroll - 10) {
            container.scrollTo({ top: 0, left: 0, behavior: "smooth" });
        } else {
            container.scrollBy({ top: 0, left: itemWidth, behavior: "smooth" });
        }
    }, 3000);
}

document.addEventListener("DOMContentLoaded", async () => {
    await loadClientConfig();
    try {
        if (!window.hasSupabaseConfig() || !sbClient) {
            alert("Falta configurar Supabase. Editá supabase-config.js con tu URL y anon key.");
        }
    } catch (_error) {
        // Sin acción: el error real se verá en consola al consultar.
    }
    if (supabaseInitError) {
        alert("No se pudo inicializar Supabase. Revisá la URL y key en supabase-config.js.");
    }
    if (sbClient) {
        try {
            await DB.seedDefaultsIfEmpty();
        } catch (error) {
            console.error(error);
            alert("No se pudieron cargar datos iniciales desde Supabase.");
        }
    }
    startCarousel();
});

// Exponer handlers al scope global para onclick en HTML.
window.navigateTo = navigateTo;
window.askForDetails = askForDetails;
window.confirmBooking = confirmBooking;
window.startNewBooking = startNewBooking;
