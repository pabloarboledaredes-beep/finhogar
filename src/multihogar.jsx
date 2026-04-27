// ── NESTGROW MULTI-HOGAR SYSTEM ───────────────────────────────────────────────
// Este archivo maneja toda la lógica de autenticación, creación de hogares,
// invitaciones y panel de estadísticas del sistema.

import { useState, useEffect, useCallback, useRef } from "react";
import { auth, db, googleProvider } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import {
  doc, getDoc, setDoc, updateDoc, onSnapshot,
  collection, serverTimestamp, arrayUnion
} from "firebase/firestore";

// ── COLORES ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#F7F8FA", surface: "#FFFFFF", surfaceAlt: "#F2F4F7", surfaceHigh: "#E8EBF0",
  border: "#E2E6ED", accent: "#1A7CF4", accentDim: "#1A7CF408",
  accentOrange: "#F5640A", accentBlue: "#1A7CF4", accentPurple: "#7C3AED",
  accentRed: "#E02D3C", accentYellow: "#D97706", accentPink: "#DB2777",
  text: "#0F1623", textMuted: "#6B7280", textSub: "#D1D5DB", white: "#ffffff",
};

const inputSt = {
  width: "100%", padding: "12px 14px", borderRadius: 10,
  border: `1.5px solid ${C.border}`, background: C.surface,
  color: C.text, fontSize: 15, outline: "none",
  boxSizing: "border-box", fontFamily: "inherit",
};

const btn = (bg = C.accent, fg = "#fff") => ({
  background: bg, color: fg, border: "none", borderRadius: 10,
  padding: "13px 20px", fontWeight: 700, fontSize: 14,
  cursor: "pointer", fontFamily: "inherit", width: "100%",
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

const INIT_HOGAR = {
  members: [{ id: 1, name: "Miembro 1", color: "#1A7CF4", emoji: "👨" }],
  categories: ["Alimentación","Transporte","Servicios","Entretenimiento","Salud","Educación","Ropa","Hogar","Otros"],
  incomes: [], expenses: [], cards: [], loans: [],
  budgets: [], savings: [], fixedBills: [],
};

// ── LOGIN SCREEN ──────────────────────────────────────────────────────────────
export const LoginScreen = ({ onLogin, loading }) => (
  <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <div style={{ fontSize: 56, marginBottom: 16 }}>🪺</div>
    <div style={{ fontSize: 28, fontWeight: 900, color: C.text, letterSpacing: -0.5, marginBottom: 6 }}>NestGrow</div>
    <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 40, textAlign: "center" }}>
      El nido que crece · Control financiero del hogar
    </div>
    <div style={{ width: "100%", maxWidth: 340, background: C.surface, borderRadius: 20, padding: 28, border: `1.5px solid ${C.border}`, boxShadow: "0 4px 24px rgba(0,0,0,0.06)" }}>
      <div style={{ color: C.text, fontWeight: 800, fontSize: 18, marginBottom: 6, textAlign: "center" }}>Bienvenido 👋</div>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 24, textAlign: "center", lineHeight: 1.6 }}>
        Inicia sesión con tu cuenta de Google para acceder o crear tu hogar.
      </div>
      <button onClick={onLogin} disabled={loading} style={{ ...btn(), display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <svg width="20" height="20" viewBox="0 0 48 48">
          <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 2.9l5.7-5.7C34.5 6.5 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.1 8 2.9l5.7-5.7C34.5 6.5 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.1l-6.2-5.2C29.3 35.5 26.8 36 24 36c-5.1 0-9.6-3.2-11.3-7.8l-6.5 5C9.5 39.5 16.2 44 24 44z"/>
          <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.3 5.5l6.2 5.2C37 36.8 44 31 44 24c0-1.3-.1-2.6-.4-3.9z"/>
        </svg>
        {loading ? "Entrando..." : "Continuar con Google"}
      </button>
    </div>
    <div style={{ color: C.textMuted, fontSize: 11, marginTop: 24, textAlign: "center" }}>
      Al entrar aceptas que tus datos financieros se guardan<br />de forma privada y encriptada en Google Firebase.
    </div>
  </div>
);

// ── ONBOARDING — Crear o unirse a un hogar ────────────────────────────────────
export const OnboardingScreen = ({ user, onHogarReady, onLogout }) => {
  const [screen, setScreen] = useState("inicio"); // inicio | crear | unirse
  const [hogarName, setHogarName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const crearHogar = async () => {
    if (!hogarName.trim()) { setError("Ponle un nombre a tu hogar"); return; }
    setLoading(true); setError("");
    try {
      const hogarId = `hogar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const code = generateInviteCode();
      const hogarData = {
        ...INIT_HOGAR,
        hogarId,
        nombre: hogarName.trim(),
        inviteCode: code,
        memberUids: [user.uid],
        memberEmails: [user.email],
        createdAt: serverTimestamp(),
        plan: "gratuito",
        members: [{ id: 1, name: user.displayName?.split(" ")[0] || "Yo", color: "#1A7CF4", emoji: "👨", uid: user.uid, email: user.email }],
      };
      await setDoc(doc(db, "hogares", hogarId), hogarData);
      await setDoc(doc(db, "usuarios", user.uid), {
        hogarId, nombre: user.displayName || user.email,
        email: user.email, rol: "admin", joinedAt: serverTimestamp(),
      });
      // Write public invite document so others can join
      await setDoc(doc(db, "invitaciones", code), {
        hogarId, createdAt: serverTimestamp(), createdBy: user.uid,
      });
      // Update system stats
      try {
        const statsRef = doc(db, "_sistema", "stats");
        const stats = await getDoc(statsRef);
        await setDoc(statsRef, {
          totalHogares: (stats.data()?.totalHogares || 0) + 1,
          totalUsuarios: (stats.data()?.totalUsuarios || 0) + 1,
          lastUpdated: serverTimestamp(),
        }, { merge: true });
      } catch {}
      onHogarReady(hogarId, code);
    } catch (e) {
      setError("Error al crear el hogar. Intenta de nuevo.");
      console.error(e);
    }
    setLoading(false);
  };

  const unirseHogar = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (code.length !== 8) { setError("El código debe tener 8 caracteres"); return; }
    setLoading(true); setError("");
    try {
      // Look up invite code in public collection (readable by any authenticated user)
      const inviteRef = doc(db, "invitaciones", code);
      const inviteSnap = await getDoc(inviteRef);

      if (!inviteSnap.exists()) {
        setError("Código inválido. Verifica con quien te lo compartió.");
        setLoading(false); return;
      }

      const { hogarId } = inviteSnap.data();

      // Now read the hogar — user is not yet a member so we use a cloud-safe approach
      // We add the user first, then read
      const newMember = {
        id: Date.now(),
        name: user.displayName?.split(" ")[0] || "Nuevo miembro",
        color: "#DB2777", emoji: "👩", uid: user.uid, email: user.email,
      };

      // Write user profile first (user can always write their own profile)
      await setDoc(doc(db, "usuarios", user.uid), {
        hogarId, nombre: user.displayName || user.email,
        email: user.email, rol: "miembro", joinedAt: serverTimestamp(),
      });

      // Use a special join endpoint — update hogar via the invite record
      // We need to use a Firestore transaction-like approach
      // First get current hogar data with elevated access via invite
      const hogarRef = doc(db, "hogares", hogarId);

      // Since user is not yet a member, we use arrayUnion via a writable path
      // The invite document authorizes this write
      await updateDoc(hogarRef, {
        memberUids: arrayUnion(user.uid),
        memberEmails: arrayUnion(user.email),
        members: arrayUnion(newMember),
      });

      // Update stats
      try {
        const statsRef = doc(db, "_sistema", "stats");
        const stats = await getDoc(statsRef);
        await setDoc(statsRef, {
          totalUsuarios: (stats.data()?.totalUsuarios || 0) + 1,
          lastUpdated: serverTimestamp(),
        }, { merge: true });
      } catch {}

      onHogarReady(hogarId, null);
    } catch (e) {
      setError("Error al unirse. Verifica el código e intenta de nuevo.");
      console.error(e);
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🪺</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: C.text, marginBottom: 4 }}>Bienvenido, {user.displayName?.split(" ")[0]}!</div>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 32, textAlign: "center" }}>Es tu primera vez en NestGrow.<br />¿Qué quieres hacer?</div>

      {screen === "inicio" && (
        <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
          <button onClick={() => setScreen("crear")} style={{ ...btn(), padding: "18px" }}>
            🏡 Crear mi hogar
          </button>
          <button onClick={() => setScreen("unirse")} style={{ ...btn("transparent", C.accent), border: `1.5px solid ${C.accent}` }}>
            🔑 Unirme con código de invitación
          </button>
          <button onClick={onLogout} style={{ ...btn("transparent", C.textMuted), border: `1.5px solid ${C.border}`, marginTop: 8 }}>
            Salir
          </button>
        </div>
      )}

      {screen === "crear" && (
        <div style={{ width: "100%", maxWidth: 340, background: C.surface, borderRadius: 20, padding: 24, border: `1.5px solid ${C.border}` }}>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 16, marginBottom: 16 }}>🏡 Crear mi hogar</div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: C.textMuted, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>NOMBRE DEL HOGAR</div>
            <input placeholder="Ej: Hogar Arboleda, Casa Tamayo..." value={hogarName} onChange={e => setHogarName(e.target.value)} style={inputSt} />
          </div>
          {error && <div style={{ color: C.accentRed, fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={crearHogar} disabled={loading} style={{ ...btn(), flex: 2 }}>{loading ? "Creando..." : "Crear hogar"}</button>
            <button onClick={() => { setScreen("inicio"); setError(""); }} style={{ ...btn("transparent", C.textMuted), border: `1.5px solid ${C.border}`, flex: 1 }}>Volver</button>
          </div>
          <div style={{ color: C.textMuted, fontSize: 11, marginTop: 12, lineHeight: 1.6, textAlign: "center" }}>
            Se generará un código de invitación para que tu pareja pueda unirse.
          </div>
        </div>
      )}

      {screen === "unirse" && (
        <div style={{ width: "100%", maxWidth: 340, background: C.surface, borderRadius: 20, padding: 24, border: `1.5px solid ${C.border}` }}>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 16, marginBottom: 16 }}>🔑 Unirme con código</div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: C.textMuted, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>CÓDIGO DE INVITACIÓN</div>
            <input
              placeholder="XXXXXXXX"
              value={inviteCode}
              onChange={e => setInviteCode(e.target.value.toUpperCase())}
              maxLength={8}
              style={{ ...inputSt, textAlign: "center", fontSize: 22, fontWeight: 800, letterSpacing: 4 }}
            />
          </div>
          {error && <div style={{ color: C.accentRed, fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={unirseHogar} disabled={loading} style={{ ...btn(), flex: 2 }}>{loading ? "Buscando..." : "Unirme"}</button>
            <button onClick={() => { setScreen("inicio"); setError(""); }} style={{ ...btn("transparent", C.textMuted), border: `1.5px solid ${C.border}`, flex: 1 }}>Volver</button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── INVITE CODE BANNER ─────────────────────────────────────────────────────────
export const InviteCodeBanner = ({ code, hogarNombre, onDismiss }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000BB", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: C.surface, borderRadius: 20, padding: 28, maxWidth: 340, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
        <div style={{ color: C.text, fontWeight: 900, fontSize: 20, marginBottom: 6 }}>¡Hogar creado!</div>
        <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>
          Comparte este código con tu pareja para que pueda unirse a <strong>{hogarNombre}</strong>:
        </div>
        <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: "16px", marginBottom: 16 }}>
          <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: 6, color: C.accent }}>{code}</div>
        </div>
        <button onClick={copy} style={{ ...btn(copied ? C.accent : C.surfaceAlt, copied ? "#fff" : C.text), marginBottom: 10 }}>
          {copied ? "✓ Copiado" : "📋 Copiar código"}
        </button>
        <button onClick={onDismiss} style={{ ...btn("transparent", C.textMuted), border: `1.5px solid ${C.border}` }}>
          Continuar a la app
        </button>
        <div style={{ color: C.textMuted, fontSize: 11, marginTop: 12 }}>
          También puedes ver el código más tarde en ⚙️ Config → Hogar
        </div>
      </div>
    </div>
  );
};

// ── PANEL DE SISTEMA (solo para el creador) ───────────────────────────────────
export const SistemaPanel = ({ user, onClose }) => {
  const [stats, setStats] = useState(null);
  const CREATOR_EMAIL = "pabloarboleda.redes@gmail.com";
  const isCreator = user?.email === CREATOR_EMAIL;

  useEffect(() => {
    if (!isCreator) return;
    const unsub = onSnapshot(doc(db, "_sistema", "stats"), snap => {
      if (snap.exists()) setStats(snap.data());
    });
    return unsub;
  }, [isCreator]);

  // Firestore free tier limits
  const LIMITS = {
    reads: { used: 0, limit: 50000, label: "Lecturas/día" },
    writes: { used: 0, limit: 20000, label: "Escrituras/día" },
    storage: { used: 0, limit: 1024, label: "Almacenamiento (MB)" },
    hogares: { used: stats?.totalHogares || 0, limit: 100, label: "Hogares (estimado gratuito)" },
  };

  if (!isCreator) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000BB", zIndex: 999, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: C.surface, borderRadius: "20px 20px 0 0", padding: 24, width: "100%", maxWidth: 520, maxHeight: "80vh", overflowY: "auto", paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 18 }}>📊 Panel del Sistema</div>
          <button onClick={onClose} style={{ background: C.surfaceAlt, border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, color: C.textMuted }}>×</button>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {[
            ["🏠 Hogares", stats?.totalHogares || 0, C.accent],
            ["👥 Usuarios", stats?.totalUsuarios || 0, C.accentPurple],
          ].map(([label, value, color]) => (
            <div key={label} style={{ background: C.surfaceAlt, borderRadius: 12, padding: 14, textAlign: "center" }}>
              <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 700 }}>{label}</div>
              <div style={{ color, fontSize: 28, fontWeight: 900, marginTop: 4 }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Firebase Free Tier Gauge */}
        <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Estado del Plan Gratuito</div>
        <div style={{ background: C.surfaceAlt, borderRadius: 12, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ color: C.textMuted, fontSize: 13 }}>Hogares registrados</span>
            <span style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{stats?.totalHogares || 0}</span>
          </div>
          <div style={{ background: C.border, borderRadius: 99, height: 8, marginBottom: 6 }}>
            <div style={{ width: `${Math.min(((stats?.totalHogares || 0) / 100) * 100, 100)}%`, height: "100%", background: C.accent, borderRadius: 99 }} />
          </div>
          <div style={{ color: C.textMuted, fontSize: 11 }}>~{stats?.totalHogares || 0} / 100 hogares estimados en plan gratuito</div>
        </div>

        <div style={{ background: C.accentBlue + "10", border: `1px solid ${C.accentBlue}33`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ color: C.accentBlue, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>💡 Capacidad estimada gratuita</div>
          {[
            ["Hogares sin costo", "~50-100 hogares activos"],
            ["Almacenamiento", "1 GB (≈ 10.000+ hogares)"],
            ["Lecturas/día", "50.000 (≈ 500 usuarios activos)"],
            ["Escrituras/día", "20.000 (≈ 200 usuarios activos)"],
            ["Bandwidth Vercel", "100 GB/mes (ilimitado para este uso)"],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: C.textMuted, fontSize: 12 }}>{k}</span>
              <span style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>

        <div style={{ background: C.accentYellow + "10", border: `1px solid ${C.accentYellow}33`, borderRadius: 12, padding: 14 }}>
          <div style={{ color: C.accentYellow, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>⚠️ Cuándo considerar pagar</div>
          <div style={{ color: C.textMuted, fontSize: 12, lineHeight: 1.6 }}>
            Cuando superes ~100 hogares activos simultáneos, Firebase Spark (gratuito) puede quedarse corto en lecturas diarias. El plan Blaze (pago por uso) costaría aproximadamente $5-15 USD/mes para 500 usuarios activos.
          </div>
        </div>

        {stats?.lastUpdated && (
          <div style={{ color: C.textMuted, fontSize: 11, marginTop: 12, textAlign: "center" }}>
            Última actualización: {new Date(stats.lastUpdated?.toDate?.() || Date.now()).toLocaleString("es-CO")}
          </div>
        )}
      </div>
    </div>
  );
};

// ── HOOK PRINCIPAL — useHogar ─────────────────────────────────────────────────
export function useHogar(user) {
  const [hogarId, setHogarId] = useState(null);
  const [hogarData, setHogarData] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newHogarCode, setNewHogarCode] = useState(null);
  const saveTimer = useRef(null);
  const [syncing, setSyncing] = useState(false);

  // Load user profile → find hogarId
  useEffect(() => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    getDoc(doc(db, "usuarios", user.uid)).then(snap => {
      if (snap.exists()) {
        const profile = snap.data();
        setUserProfile(profile);
        setHogarId(profile.hogarId);
      } else {
        setLoading(false); // No profile → needs onboarding
      }
    }).catch(() => setLoading(false));
  }, [user]);

  // Real-time listener for hogar data
  useEffect(() => {
    if (!hogarId) { if (user) setLoading(false); return; }
    const unsub = onSnapshot(doc(db, "hogares", hogarId), snap => {
      if (snap.exists()) {
        setHogarData({ ...INIT_HOGAR, ...snap.data() });
      }
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [hogarId]);

  // Save hogar data (debounced)
  const saveHogar = useCallback((updater) => {
    setHogarData(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        setSyncing(true);
        setDoc(doc(db, "hogares", hogarId), next)
          .then(() => setSyncing(false))
          .catch(() => setSyncing(false));
      }, 600);
      return next;
    });
  }, [hogarId]);

  const onHogarReady = (id, code) => {
    setHogarId(id);
    if (code) setNewHogarCode(code);
  };

  const dismissNewHogar = () => setNewHogarCode(null);

  return { hogarId, hogarData, userProfile, loading, syncing, saveHogar, newHogarCode, onHogarReady, dismissNewHogar };
}
