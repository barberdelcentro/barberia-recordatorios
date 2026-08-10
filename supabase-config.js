// Configuracion compartida de Supabase para index/admin.
window.DEPLOY_TAG = "fix-cb-001";
window.SUPABASE_URL = "__SUPABASE_URL__";
window.SUPABASE_ANON_KEY = "__SUPABASE_KEY__";

window.hasSupabaseConfig = function hasSupabaseConfig() {
    return (
        typeof window.SUPABASE_URL === "string" &&
        typeof window.SUPABASE_ANON_KEY === "string" &&
        !window.SUPABASE_URL.includes("AQUI") &&
        !window.SUPABASE_ANON_KEY.includes("AQUI")
    );
};

window.createSupabaseClient = function createSupabaseClient() {
    if (!window.supabase || !window.supabase.createClient) {
        throw new Error("No se pudo cargar supabase-js.");
    }
    if (!window.hasSupabaseConfig()) {
        throw new Error("Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY.");
    }
    return window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
};
