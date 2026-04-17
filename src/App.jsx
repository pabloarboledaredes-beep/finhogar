import { useState, useMemo, useEffect, useCallback } from "react";
import { auth, db, googleProvider } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot, setDoc, getDoc } from "firebase/firestore";

// ── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const C = {
  bg: "#F7F8FA", surface: "#FFFFFF", surfaceAlt: "#F2F4F7", surfaceHigh: "#E8EBF0",
  border: "#E2E6ED", borderLight: "#EDF0F4",
  accent: "#1A7CF4", accentDim: "#1A7CF408",
  accentOrange: "#F5640A", accentBlue: "#1A7CF4", accentPurple: "#7C3AED",
  accentRed: "#E02D3C", accentYellow: "#D97706", accentPink: "#DB2777",
  text: "#0F1623", textMuted: "#6B7280", textSub: "#D1D5DB", white: "#ffffff",
};

// ── UTILS ─────────────────────────────────────────────────────────────────────
const fmt = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n || 0);
const fmtPct = (n) => `${(n || 0).toFixed(1)}%`;
const fmtShort = (n) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return fmt(n);
};

function buildLoanAmortization(principal, monthlyRate, numPayments, alreadyPaid = 0) {
  const r = monthlyRate / 100;
  const pmt = r === 0 ? principal / numPayments : (principal * r * Math.pow(1 + r, numPayments)) / (Math.pow(1 + r, numPayments) - 1);
  const rows = [];
  let balance = principal;
  for (let i = 1; i <= numPayments; i++) {
    const interest = balance * r;
    const capitalAmt = pmt - interest;
    balance = Math.max(0, balance - capitalAmt);
    rows.push({ cuota: i, pmt: Math.round(pmt), interest: Math.round(interest), capital: Math.round(capitalAmt), balance: Math.round(balance), paid: i <= alreadyPaid });
  }
  return { rows, pmt: Math.round(pmt) };
}

function buildPurchaseAmortization(amount, installments, monthlyRate) {
  const r = monthlyRate / 100;
  if (installments === 1) return [{ cuota: 1, pmt: amount, interest: 0, capital: amount, balance: 0 }];
  const pmt = r === 0 ? amount / installments : (amount * r * Math.pow(1 + r, installments)) / (Math.pow(1 + r, installments) - 1);
  const rows = [];
  let balance = amount;
  for (let i = 1; i <= installments; i++) {
    const interest = balance * r;
    const capitalAmt = pmt - interest;
    balance = Math.max(0, balance - capitalAmt);
    rows.push({ cuota: i, pmt: Math.round(pmt), interest: Math.round(interest), capital: Math.round(capitalAmt), balance: Math.round(balance) });
  }
  return rows;
}

// ── INITIAL STATE ─────────────────────────────────────────────────────────────
const DEFAULT_CATS = ["Alimentación", "Transporte", "Servicios", "Entretenimiento", "Salud", "Educación", "Ropa", "Hogar", "Otros"];
const PAY_METHODS = ["Efectivo", "Débito", "Tarjeta de crédito"];
const BILL_COLORS = [C.accentBlue, C.accentPurple, C.accentPink, C.accentYellow, C.accentOrange, C.accent, C.accentRed];
const PAY_TYPES = ["Transferencia", "Débito automático", "Efectivo", "Débito", "Tarjeta de crédito", "PSE", "Cheque"];

const INIT = {
  members: [
    { id: 1, name: "Pablo", color: C.accentBlue, emoji: "👨" },
    { id: 2, name: "Mi esposa", color: C.accentPink, emoji: "👩" },
  ],
  categories: [...DEFAULT_CATS],
  incomes: [], expenses: [], cards: [], loans: [],
  budgets: [
    { id: 1, category: "Alimentación", limit: 900000, spent: 0 },
    { id: 2, category: "Transporte", limit: 450000, spent: 0 },
    { id: 3, category: "Servicios", limit: 350000, spent: 0 },
    { id: 4, category: "Entretenimiento", limit: 300000, spent: 0 },
    { id: 5, category: "Salud", limit: 250000, spent: 0 },
  ],
  savings: [
    { id: 1, name: "Fondo de Emergencia", goal: 10000000, current: 0, color: C.accent },
  ],
  fixedBills: [],
};

// ── CORREOS AUTORIZADOS ───────────────────────────────────────────────────────
const ALLOWED_EMAILS = [
  "pabloarboleda.redes@gmail.com",
  "lauratamayo1911@gmail.com",
];
function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function getToday() { return new Date().toISOString().slice(0, 10); }
function getDaysUntilDue(dueDay) {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), dueDay);
  const diff = Math.ceil((thisMonth - now) / (1000 * 60 * 60 * 24));
  if (diff < -1) {
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
    return Math.ceil((nextMonth - now) / (1000 * 60 * 60 * 24));
  }
  return diff;
}
function getAlertLevel(d) { if (d < 0) return "vencido"; if (d === 0) return "hoy"; if (d <= 3) return "urgente"; if (d <= 7) return "pronto"; return "ok"; }
function getAlertStyle(level) {
  return { vencido: { color: C.accentRed, label: "VENCIDO", bg: C.accentRed + "12" }, hoy: { color: C.accentRed, label: "HOY", bg: C.accentRed + "12" }, urgente: { color: C.accentOrange, label: "URGENTE", bg: C.accentOrange + "12" }, pronto: { color: C.accentYellow, label: "ESTA SEMANA", bg: C.accentYellow + "12" }, ok: { color: C.textMuted, label: "PENDIENTE", bg: "transparent" } }[level] || { color: C.textMuted, label: "PENDIENTE", bg: "transparent" };
}
function fmtMonth(ym) {
  const [y, m] = ym.split("-");
  return `${["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"][parseInt(m,10)-1]} ${y}`;
}

// ── SHARED UI ─────────────────────────────────────────────────────────────────
const inputSt = { width: "100%", padding: "10px 14px", borderRadius: 8, border: `1.5px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit", maxWidth: "100%", display: "block" };
const btnPrimary = (bg = C.accent, fg = "#fff") => ({ background: bg, color: fg, border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" });
const btnGhost = { background: "transparent", color: C.textMuted, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "10px 18px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };

const Box = ({ children, style = {} }) => (
  <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 18, boxShadow: "0 1px 4px rgba(0,0,0,0.05)", ...style }}>{children}</div>
);
const Bar = ({ value, max, color = C.accent, h = 5 }) => {
  const pct = Math.min((value / (max || 1)) * 100, 100);
  const col = pct > 90 ? C.accentRed : pct > 70 ? C.accentYellow : color;
  return <div style={{ background: C.surfaceHigh, borderRadius: 99, height: h, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: col, borderRadius: 99, transition: "width .4s ease" }} /></div>;
};
const Tag = ({ color = C.accent, children }) => <span style={{ background: color + "12", color, fontSize: 11, padding: "3px 9px", borderRadius: 6, fontWeight: 700 }}>{children}</span>;
const NavBtn = ({ icon, label, active, onClick }) => (
  <button onClick={onClick} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "7px 10px", borderRadius: 10, border: "none", cursor: "pointer", background: active ? C.accent + "10" : "transparent", color: active ? C.accent : C.textMuted, fontSize: 10, fontWeight: active ? 700 : 500, fontFamily: "inherit" }}>
    <span style={{ fontSize: 18 }}>{icon}</span>{label}
  </button>
);
const Divider = () => <div style={{ height: 1, background: C.border, margin: "10px 0" }} />;
const Label = ({ children }) => <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 5 }}>{children}</div>;

// ── DATE PICKER — 3 selectores nativos, funciona igual en iPhone y desktop ────
const MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
function dateToparts(iso) {
  const [y, m, d] = iso.split("-");
  return { d: parseInt(d,10), m: parseInt(m,10), y: parseInt(y,10) };
}
function partsToDays(m, y) {
  return new Date(y, m, 0).getDate();
}
const DatePicker = ({ value, onChange }) => {
  const { d, m, y } = dateToparts(value);
  const maxDay = partsToDays(m, y);
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);
  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i);
  const sel = { ...inputSt, flex: 1, padding: "10px 8px", fontSize: 13 };
  const pad = (n) => String(n).padStart(2, "0");
  const update = (nd, nm, ny) => onChange(`${ny}-${pad(nm)}-${pad(Math.min(nd, partsToDays(nm, ny)))}`);
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <select value={d} onChange={e => update(+e.target.value, m, y)} style={sel}>
        {days.map(n => <option key={n} value={n}>{pad(n)}</option>)}
      </select>
      <select value={m} onChange={e => update(d, +e.target.value, y)} style={{ ...sel, flex: 2 }}>
        {MONTHS.map((name, i) => <option key={i+1} value={i+1}>{name}</option>)}
      </select>
      <select value={y} onChange={e => update(d, m, +e.target.value)} style={sel}>
        {years.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
};

const AmortTable = ({ rows, title, color = C.accent }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={() => setOpen(!open)} style={{ background: C.surfaceAlt, color: C.textMuted, border: `1.5px solid ${C.border}`, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", width: "100%", fontFamily: "inherit" }}>
        {open ? "▲" : "▼"} {title || "Ver tabla de amortización"} ({rows.length} cuotas)
      </button>
      {open && (
        <div style={{ marginTop: 8, borderRadius: 10, border: `1.5px solid ${C.border}`, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ background: C.surfaceAlt }}>
                {["#", "Cuota", "Interés", "Capital", "Saldo"].map(h => <th key={h} style={{ padding: "8px 8px", color: C.textMuted, fontWeight: 600, textAlign: "right", borderBottom: `1.5px solid ${C.border}` }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ background: r.paid ? C.surfaceAlt : C.surface, opacity: r.paid ? 0.5 : 1, borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "7px 8px", color: C.textMuted, textAlign: "right", fontSize: 11 }}>{r.cuota}</td>
                    <td style={{ padding: "7px 8px", color: C.text, fontWeight: 600, textAlign: "right" }}>{fmtShort(r.pmt)}</td>
                    <td style={{ padding: "7px 8px", color: C.accentRed, textAlign: "right" }}>{fmtShort(r.interest)}</td>
                    <td style={{ padding: "7px 8px", color: C.accent, textAlign: "right" }}>{fmtShort(r.capital)}</td>
                    <td style={{ padding: "7px 8px", color: C.textMuted, textAlign: "right" }}>{fmtShort(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ── ACCESS DENIED SCREEN ──────────────────────────────────────────────────────
const AccessDenied = ({ user, onLogout }) => (
  <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <div style={{ fontSize: 56, marginBottom: 16 }}>🔒</div>
    <div style={{ fontSize: 22, fontWeight: 900, color: C.text, marginBottom: 8 }}>Acceso no autorizado</div>
    <div style={{ color: C.textMuted, fontSize: 14, textAlign: "center", lineHeight: 1.6, marginBottom: 32, maxWidth: 300 }}>
      El correo <strong style={{ color: C.accentRed }}>{user.email}</strong> no tiene permiso para acceder a FinHogar.<br /><br />
      Esta app es de uso privado para Pablo y Laura.
    </div>
    <button onClick={onLogout} style={{ ...btnPrimary(C.accentRed), padding: "12px 28px", fontSize: 14 }}>
      Cerrar sesión
    </button>
  </div>
);
const LoginScreen = ({ onLogin, loading }) => (
  <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <div style={{ width: 60, height: 60, borderRadius: 16, background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, marginBottom: 20 }}>🏡</div>
    <div style={{ fontSize: 28, fontWeight: 900, color: C.text, letterSpacing: -0.5, marginBottom: 6 }}>FinHogar</div>
    <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 40, textAlign: "center" }}>Control financiero del hogar<br />Pablo & Esposa</div>
    <Box style={{ width: "100%", maxWidth: 340, textAlign: "center" }}>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Bienvenidos 👋</div>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>Inicia sesión con tu cuenta Google para acceder a las finanzas del hogar.</div>
      <button onClick={onLogin} disabled={loading} style={{ ...btnPrimary(), width: "100%", padding: "13px", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 2.9l5.7-5.7C34.5 6.5 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.1 8 2.9l5.7-5.7C34.5 6.5 29.5 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.1l-6.2-5.2C29.3 35.5 26.8 36 24 36c-5.1 0-9.6-3.2-11.3-7.8l-6.5 5C9.5 39.5 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.3 5.5l6.2 5.2C37 36.8 44 31 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
        {loading ? "Entrando..." : "Continuar con Google"}
      </button>
    </Box>
    <div style={{ color: C.textMuted, fontSize: 11, marginTop: 24, textAlign: "center" }}>Solo Pablo y su esposa tienen acceso.<br />Los datos se sincronizan en tiempo real.</div>
  </div>
);

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
const Dashboard = ({ state }) => {
  const totalIncome = state.incomes.reduce((s, i) => s + i.amount, 0);
  const totalSpent = state.budgets.reduce((s, b) => s + b.spent, 0);
  const totalCardDue = state.cards.reduce((cs, card) => cs + card.purchases.filter(p => p.paidInstallments < p.installments).reduce((sum, p) => { const rows = buildPurchaseAmortization(p.amount, p.installments, p.zeroInterest ? 0 : card.rate); return sum + (rows[p.paidInstallments]?.pmt || 0); }, 0), 0);
  const totalLoanDue = state.loans.reduce((s, l) => { const { pmt } = buildLoanAmortization(l.principal, l.rate, l.totalInstallments); return s + pmt; }, 0);
  const totalDebtDue = totalCardDue + totalLoanDue;
  const netAvail = totalIncome - totalSpent - totalDebtDue;
  const byMember = state.members.map(m => ({ ...m, income: state.incomes.filter(i => i.memberId === m.id).reduce((s, i) => s + i.amount, 0) }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>{new Date().toLocaleString("es-CO", { month: "long", year: "numeric" }).toUpperCase()}</div>
        <div style={{ color: C.text, fontSize: 22, fontWeight: 900, letterSpacing: -0.5 }}>Panel Principal</div>
      </div>
      <Box style={{ borderColor: netAvail >= 0 ? C.accent : C.accentRed }}>
        <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 600, letterSpacing: 0.8 }}>FLUJO LIBRE DEL MES</div>
        <div style={{ color: netAvail >= 0 ? C.accent : C.accentRed, fontSize: 32, fontWeight: 900, letterSpacing: -1, marginTop: 4 }}>{fmt(netAvail)}</div>
        <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>Ingresos − Gastos − Deudas del mes</div>
        <Divider />
        <div style={{ display: "flex", gap: 16 }}>
          {byMember.map(m => <div key={m.id} style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ fontSize: 14 }}>{m.emoji}</span><span style={{ color: m.color, fontSize: 13, fontWeight: 700 }}>{fmt(m.income)}</span></div>)}
        </div>
      </Box>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {[["Ingresos", fmt(totalIncome), "💰", C.accent], ["Gastos", fmt(totalSpent), "🛒", C.accentOrange], ["Cuotas/mes", fmt(totalDebtDue), "💳", C.accentPurple], ["Ahorrado", fmt(state.savings.reduce((s, sv) => s + sv.current, 0)), "🐷", C.accentBlue]].map(([label, value, icon, color]) => (
          <Box key={label}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: C.textMuted, fontSize: 11, fontWeight: 700 }}>{label.toUpperCase()}</span><span style={{ fontSize: 18 }}>{icon}</span></div>
            <div style={{ color, fontSize: 20, fontWeight: 800, marginTop: 6 }}>{value}</div>
          </Box>
        ))}
      </div>
      <Box>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Presupuestos</div>
        {state.budgets.slice(0, 5).map(b => (
          <div key={b.id} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ color: C.textMuted, fontSize: 12 }}>{b.category}</span><span style={{ color: C.textMuted, fontSize: 12 }}>{fmt(b.spent)} / {fmt(b.limit)}</span></div>
            <Bar value={b.spent} max={b.limit} />
          </div>
        ))}
      </Box>
      <Box>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Metas de Ahorro</div>
        {state.savings.map(s => (
          <div key={s.id} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{s.name}</span><span style={{ color: s.color, fontSize: 12, fontWeight: 700 }}>{fmtPct((s.current / s.goal) * 100)}</span></div>
            <Bar value={s.current} max={s.goal} color={s.color} h={7} />
          </div>
        ))}
      </Box>
      <Box>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginBottom: 12 }}>📅 Próximas obligaciones</div>
        {state.cards.map(c => (
          <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
            <div><div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{c.name}</div><div style={{ color: C.textMuted, fontSize: 11 }}>Tarjeta · Cierre día {c.dueDate}</div></div>
            <Tag color={C.accentOrange}>{fmtShort(c.purchases.filter(p => p.paidInstallments < p.installments).reduce((sum, p) => { const rows = buildPurchaseAmortization(p.amount, p.installments, p.zeroInterest ? 0 : c.rate); return sum + (rows[p.paidInstallments]?.pmt || 0); }, 0))}</Tag>
          </div>
        ))}
        {state.loans.map(l => { const { pmt } = buildLoanAmortization(l.principal, l.rate, l.totalInstallments); return (<div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}><div><div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{l.name}</div><div style={{ color: C.textMuted, fontSize: 11 }}>{l.bank} · Crédito</div></div><Tag color={C.accentPurple}>{fmtShort(pmt)}</Tag></div>); })}
        {(() => {
          const cm = getCurrentMonth();
          const alerts = (state.fixedBills || []).filter(b => !b.payments.find(p => p.month === cm)?.paid).map(b => ({ ...b, daysLeft: getDaysUntilDue(b.dueDay) })).filter(b => b.daysLeft <= 7).sort((a, b2) => a.daysLeft - b2.daysLeft);
          if (!alerts.length) return null;
          return (<>
            <div style={{ color: C.accentYellow, fontSize: 11, fontWeight: 700, marginTop: 10, marginBottom: 4 }}>⚠️ PAGOS FIJOS PRÓXIMOS (7 días)</div>
            {alerts.map(b => { const st = getAlertStyle(getAlertLevel(b.daysLeft)); return (<div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}><div><div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{b.concept}</div><div style={{ color: C.textMuted, fontSize: 11 }}>{b.category} · Día {b.dueDay}</div></div><div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}><span style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{fmtShort(b.amount)}</span><Tag color={st.color}>{st.label}</Tag></div></div>); })}
          </>);
        })()}
      </Box>
    </div>
  );
};

// ── INGRESOS ──────────────────────────────────────────────────────────────────
const Ingresos = ({ state, setState }) => {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ memberId: 1, desc: "", amount: "", type: "fijo", date: getToday() });
  const totalByMember = useMemo(() => state.members.map(m => ({ ...m, total: state.incomes.filter(i => i.memberId === m.id).reduce((s, i) => s + i.amount, 0), fijo: state.incomes.filter(i => i.memberId === m.id && i.type === "fijo").reduce((s, i) => s + i.amount, 0), variable: state.incomes.filter(i => i.memberId === m.id && i.type === "variable").reduce((s, i) => s + i.amount, 0) })), [state.incomes, state.members]);
  const totalHousehold = totalByMember.reduce((s, m) => s + m.total, 0);
  const addIncome = () => { if (!form.desc || !form.amount) return; setState(s => ({ ...s, incomes: [{ id: Date.now(), ...form, memberId: +form.memberId, amount: +form.amount }, ...s.incomes] })); setForm({ memberId: 1, desc: "", amount: "", type: "fijo", date: getToday() }); setShowForm(false); };
  const deleteIncome = (id) => setState(s => ({ ...s, incomes: s.incomes.filter(i => i.id !== id) }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>Ingresos del Hogar</div><div style={{ color: C.textMuted, fontSize: 12 }}>Control de ingresos por persona</div></div>
        <button onClick={() => setShowForm(!showForm)} style={btnPrimary()}>+ Ingreso</button>
      </div>
      <Box style={{ borderColor: C.accent, background: C.accent + "08" }}>
        <div style={{ color: C.accent, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>INGRESO TOTAL DEL HOGAR</div>
        <div style={{ color: C.text, fontSize: 32, fontWeight: 900, letterSpacing: -1, marginTop: 4 }}>{fmt(totalHousehold)}</div>
        <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>Este mes · Ambos aportantes</div>
      </Box>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {totalByMember.map(m => (
          <Box key={m.id} style={{ borderColor: m.color + "44" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}><span style={{ fontSize: 22 }}>{m.emoji}</span><span style={{ color: m.color, fontWeight: 800, fontSize: 14 }}>{m.name}</span></div>
            <div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>{fmt(m.total)}</div>
            <Divider />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: C.textMuted, fontSize: 11 }}>Fijo</span><span style={{ color: C.accent, fontSize: 11, fontWeight: 700 }}>{fmt(m.fijo)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: C.textMuted, fontSize: 11 }}>Variable</span><span style={{ color: C.accentYellow, fontSize: 11, fontWeight: 700 }}>{fmt(m.variable)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: C.textMuted, fontSize: 11 }}>% del hogar</span><span style={{ color: m.color, fontSize: 11, fontWeight: 700 }}>{fmtPct((m.total / (totalHousehold || 1)) * 100)}</span></div>
            </div>
            <div style={{ marginTop: 8 }}><Bar value={m.total} max={totalHousehold} color={m.color} /></div>
          </Box>
        ))}
      </div>
      {showForm && (
        <Box style={{ borderColor: C.accent + "44" }}>
          <div style={{ color: C.accent, fontWeight: 800, marginBottom: 14, fontSize: 15 }}>➕ Registrar Ingreso</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div><Label>Persona</Label><select value={form.memberId} onChange={e => setForm(f => ({ ...f, memberId: e.target.value }))} style={inputSt}>{state.members.map(m => <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>)}</select></div>
            <div><Label>Descripción</Label><input placeholder="Ej: Honorarios, consultoría..." value={form.desc} onChange={e => setForm(f => ({ ...f, desc: e.target.value }))} style={inputSt} /></div>
            <div><Label>Valor ($)</Label><input type="number" placeholder="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={inputSt} /></div>
            <div><Label>Tipo</Label><select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={inputSt}><option value="fijo">Fijo (recurrente)</option><option value="variable">Variable (esporádico)</option></select></div>
            <div><Label>Fecha</Label><DatePicker value={form.date} onChange={v => setForm(f => ({ ...f, date: v }))} /></div>
            <div style={{ display: "flex", gap: 8 }}><button onClick={addIncome} style={btnPrimary()}>Guardar</button><button onClick={() => setShowForm(false)} style={btnGhost}>Cancelar</button></div>
          </div>
        </Box>
      )}
      <Box>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Historial de Ingresos</div>
        {state.incomes.length === 0 && <div style={{ color: C.textMuted, fontSize: 13 }}>Sin ingresos registrados</div>}
        {state.incomes.map(inc => { const member = state.members.find(m => m.id === inc.memberId); return (
          <div key={inc.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 18 }}>{member?.emoji}</span><div><div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{inc.desc}</div><div style={{ color: C.textMuted, fontSize: 11 }}>{member?.name} · {inc.date} · <span style={{ color: inc.type === "fijo" ? C.accent : C.accentYellow }}>{inc.type}</span></div></div></div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ color: C.accent, fontWeight: 700, fontSize: 14 }}>+{fmt(inc.amount)}</div><button onClick={() => deleteIncome(inc.id)} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 18 }}>×</button></div>
          </div>
        ); })}
      </Box>
    </div>
  );
};

// ── GASTOS ────────────────────────────────────────────────────────────────────
const Gastos = ({ state, setState }) => {
  const CATS = state.categories || DEFAULT_CATS;
  const [showExpForm, setShowExpForm] = useState(false);
  const [showBudgetForm, setShowBudgetForm] = useState(false);
  const [expForm, setExpForm] = useState({ memberId: 1, category: CATS[0], desc: "", amount: "", payMethod: "Efectivo", cardId: "", installments: 1, zeroInterest: false, date: getToday() });
  const [budgetForm, setBudgetForm] = useState({ category: "", customCategory: "", limit: "", useCustom: false });
  const [editBudget, setEditBudget] = useState(null);
  const [editBudgetForm, setEditBudgetForm] = useState({ category: "", limit: "" });
  const totalIncome = state.incomes.reduce((s, i) => s + i.amount, 0);
  const totalSpent = state.budgets.reduce((s, b) => s + b.spent, 0);

  const addExpense = () => {
    if (!expForm.desc || !expForm.amount) return;
    const amt = +expForm.amount;
    const cardId = expForm.payMethod === "Tarjeta de crédito" ? +expForm.cardId : null;
    const installments = expForm.payMethod === "Tarjeta de crédito" ? +expForm.installments : 1;
    if (cardId && installments > 0) {
      setState(s => ({ ...s, cards: s.cards.map(c => c.id === cardId ? { ...c, purchases: [...c.purchases, { id: Date.now(), desc: expForm.desc, amount: amt, installments, zeroInterest: expForm.zeroInterest, date: expForm.date, paidInstallments: 0 }] } : c), budgets: s.budgets.map(b => b.category === expForm.category ? { ...b, spent: b.spent + amt } : b), expenses: [{ id: Date.now(), memberId: +expForm.memberId, category: expForm.category, desc: expForm.desc, amount: amt, payMethod: expForm.payMethod, cardId, installments, date: expForm.date }, ...s.expenses] }));
    } else {
      setState(s => ({ ...s, budgets: s.budgets.map(b => b.category === expForm.category ? { ...b, spent: b.spent + amt } : b), expenses: [{ id: Date.now(), memberId: +expForm.memberId, category: expForm.category, desc: expForm.desc, amount: amt, payMethod: expForm.payMethod, cardId: null, installments: 1, date: expForm.date }, ...s.expenses] }));
    }
    setExpForm({ memberId: 1, category: CATS[0], desc: "", amount: "", payMethod: "Efectivo", cardId: "", installments: 1, zeroInterest: false, date: getToday() });
    setShowExpForm(false);
  };

  const addBudget = () => {
    const cat = budgetForm.useCustom ? budgetForm.customCategory.trim() : budgetForm.category;
    if (!cat || !budgetForm.limit) return;
    // Add new category to state if custom
    setState(s => {
      const newCats = budgetForm.useCustom && !s.categories?.includes(cat) ? [...(s.categories || DEFAULT_CATS), cat] : s.categories || DEFAULT_CATS;
      return { ...s, categories: newCats, budgets: [...s.budgets, { id: Date.now(), category: cat, limit: +budgetForm.limit, spent: 0 }] };
    });
    setBudgetForm({ category: "", customCategory: "", limit: "", useCustom: false });
    setShowBudgetForm(false);
  };

  const startEditBudget = (b) => { setEditBudget(b.id); setEditBudgetForm({ category: b.category, limit: String(b.limit) }); };
  const saveEditBudget = () => {
    if (!editBudgetForm.limit) return;
    setState(s => ({ ...s, budgets: s.budgets.map(b => b.id === editBudget ? { ...b, category: editBudgetForm.category, limit: +editBudgetForm.limit } : b) }));
    setEditBudget(null);
  };

  const deleteBudget = (id) => setState(s => ({ ...s, budgets: s.budgets.filter(b => b.id !== id) }));
  const deleteExpense = (expId) => setState(s => ({ ...s, expenses: s.expenses.filter(e => e.id !== expId) }));
  const pmIcon = { "Efectivo": "💵", "Débito": "💳", "Tarjeta de crédito": "🔴" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>Gastos y Presupuestos</div><div style={{ color: C.textMuted, fontSize: 12 }}>Gasto: {fmt(totalSpent)} / {fmt(totalIncome)}</div></div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setShowBudgetForm(!showBudgetForm); setShowExpForm(false); }} style={{ ...btnPrimary(C.accentBlue), fontSize: 12, padding: "8px 12px" }}>+ Presupuesto</button>
          <button onClick={() => { setShowExpForm(!showExpForm); setShowBudgetForm(false); }} style={{ ...btnPrimary(), fontSize: 12, padding: "8px 12px" }}>+ Gasto</button>
        </div>
      </div>

      {showBudgetForm && (
        <Box style={{ borderColor: C.accentBlue + "44" }}>
          <div style={{ color: C.accentBlue, fontWeight: 800, marginBottom: 12 }}>Nuevo Presupuesto</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <Label>Nombre de la categoría</Label>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button onClick={() => setBudgetForm(f => ({ ...f, useCustom: false }))} style={{ ...budgetForm.useCustom ? btnGhost : btnPrimary(C.accentBlue), fontSize: 12, padding: "7px 12px", flex: 1 }}>Existente</button>
                <button onClick={() => setBudgetForm(f => ({ ...f, useCustom: true }))} style={{ ...budgetForm.useCustom ? btnPrimary(C.accentBlue) : btnGhost, fontSize: 12, padding: "7px 12px", flex: 1 }}>Nueva categoría</button>
              </div>
              {budgetForm.useCustom
                ? <input placeholder="Ej: Mascotas, Gimnasio, Suscripciones..." value={budgetForm.customCategory} onChange={e => setBudgetForm(f => ({ ...f, customCategory: e.target.value }))} style={inputSt} />
                : <select value={budgetForm.category} onChange={e => setBudgetForm(f => ({ ...f, category: e.target.value }))} style={inputSt}><option value="">Selecciona...</option>{CATS.map(c => <option key={c}>{c}</option>)}</select>
              }
            </div>
            <div><Label>Límite mensual ($)</Label><input type="number" placeholder="0" value={budgetForm.limit} onChange={e => setBudgetForm(f => ({ ...f, limit: e.target.value }))} style={inputSt} /></div>
            <div style={{ display: "flex", gap: 8 }}><button onClick={addBudget} style={btnPrimary(C.accentBlue)}>Guardar</button><button onClick={() => setShowBudgetForm(false)} style={btnGhost}>Cancelar</button></div>
          </div>
        </Box>
      )}

      {showExpForm && (
        <Box style={{ borderColor: C.accent + "44" }}>
          <div style={{ color: C.accent, fontWeight: 800, marginBottom: 12 }}>Registrar Gasto</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div><Label>Quién gasta</Label><select value={expForm.memberId} onChange={e => setExpForm(f => ({ ...f, memberId: e.target.value }))} style={inputSt}>{state.members.map(m => <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>)}</select></div>
            <div><Label>Descripción</Label><input placeholder="¿En qué gastaste?" value={expForm.desc} onChange={e => setExpForm(f => ({ ...f, desc: e.target.value }))} style={inputSt} /></div>
            <div><Label>Categoría</Label><select value={expForm.category} onChange={e => setExpForm(f => ({ ...f, category: e.target.value }))} style={inputSt}>{CATS.map(c => <option key={c}>{c}</option>)}</select></div>
            <div><Label>Valor ($)</Label><input type="number" placeholder="0" value={expForm.amount} onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))} style={inputSt} /></div>
            <div><Label>Método de pago</Label><select value={expForm.payMethod} onChange={e => setExpForm(f => ({ ...f, payMethod: e.target.value, cardId: "", installments: 1 }))} style={inputSt}>{PAY_METHODS.map(p => <option key={p}>{p}</option>)}</select></div>
            {expForm.payMethod === "Tarjeta de crédito" && (<>
              <div><Label>Tarjeta</Label><select value={expForm.cardId} onChange={e => setExpForm(f => ({ ...f, cardId: e.target.value }))} style={inputSt}><option value="">Selecciona tarjeta...</option>{state.cards.map(c => { const h = state.members.find(m => m.id === c.holder); return <option key={c.id} value={c.id}>{c.name} ({h?.name})</option>; })}</select></div>
              <div><Label>Cuotas</Label><select value={expForm.installments} onChange={e => setExpForm(f => ({ ...f, installments: +e.target.value }))} style={inputSt}>{[1,2,3,6,9,12,18,24,36].map(n => <option key={n} value={n}>{n === 1 ? "1 cuota (contado)" : `${n} cuotas`}</option>)}</select></div>
              {expForm.installments > 1 && (
                <button
                  onClick={() => setExpForm(f => ({ ...f, zeroInterest: !f.zeroInterest }))}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
                    borderRadius: 10, border: `1.5px solid ${expForm.zeroInterest ? C.accent : C.border}`,
                    background: expForm.zeroInterest ? C.accent + "10" : C.surfaceAlt,
                    cursor: "pointer", fontFamily: "inherit", width: "100%", textAlign: "left",
                  }}
                >
                  <div style={{
                    width: 20, height: 20, borderRadius: 6, border: `2px solid ${expForm.zeroInterest ? C.accent : C.border}`,
                    background: expForm.zeroInterest ? C.accent : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  }}>
                    {expForm.zeroInterest && <span style={{ color: "#fff", fontSize: 13, fontWeight: 900 }}>✓</span>}
                  </div>
                  <div>
                    <div style={{ color: expForm.zeroInterest ? C.accent : C.text, fontWeight: 700, fontSize: 13 }}>
                      Compra sin intereses (0%)
                    </div>
                    <div style={{ color: C.textMuted, fontSize: 11, marginTop: 1 }}>
                      {expForm.zeroInterest ? "✅ Cuotas iguales sin cobro de interés" : "Las cuotas incluyen la tasa de la tarjeta"}
                    </div>
                  </div>
                </button>
              )}
              {expForm.amount && expForm.cardId && expForm.installments > 1 && (() => {
                const card = state.cards.find(c => c.id === +expForm.cardId);
                const rate = expForm.zeroInterest ? 0 : (card?.rate || 2.0);
                const rows = buildPurchaseAmortization(+expForm.amount, expForm.installments, rate);
                const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
                return (
                  <Box style={{ background: C.surfaceAlt, border: "none" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <div style={{ color: C.accentOrange, fontSize: 12, fontWeight: 700 }}>Vista previa amortización</div>
                      <Tag color={expForm.zeroInterest ? C.accent : C.accentOrange}>
                        {expForm.zeroInterest ? "Sin interés" : `Tasa ${card?.rate || 2}%/mes`}
                      </Tag>
                    </div>
                    {totalInterest > 0 && (
                      <div style={{ color: C.accentRed, fontSize: 11, marginBottom: 6, fontWeight: 600 }}>
                        Total interés a pagar: {fmt(totalInterest)}
                      </div>
                    )}
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                        <thead><tr>{["#","Cuota","Interés","Capital","Saldo"].map(h => <th key={h} style={{ color: C.textMuted, padding: "5px 4px", textAlign: "right" }}>{h}</th>)}</tr></thead>
                        <tbody>{rows.map((r, i) => <tr key={i}><td style={{ color: C.textMuted, padding: "4px", textAlign: "right" }}>{r.cuota}</td><td style={{ color: C.text, padding: "4px", textAlign: "right", fontWeight: 600 }}>{fmtShort(r.pmt)}</td><td style={{ color: r.interest > 0 ? C.accentRed : C.accent, padding: "4px", textAlign: "right" }}>{fmtShort(r.interest)}</td><td style={{ color: C.accent, padding: "4px", textAlign: "right" }}>{fmtShort(r.capital)}</td><td style={{ color: C.textMuted, padding: "4px", textAlign: "right" }}>{fmtShort(r.balance)}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </Box>
                );
              })()}
            </>)}
            <div style={{ overflow: "hidden" }}><Label>Fecha</Label><DatePicker value={expForm.date} onChange={v => setExpForm(f => ({ ...f, date: v }))} /></div>
            <div style={{ display: "flex", gap: 8 }}><button onClick={addExpense} style={btnPrimary()}>Registrar</button><button onClick={() => setShowExpForm(false)} style={btnGhost}>Cancelar</button></div>
          </div>
        </Box>
      )}

      {state.budgets.map(b => {
        const pct = (b.spent / b.limit) * 100;
        const [status, statusColor] = pct > 100 ? ["Excedido", C.accentRed] : pct > 85 ? ["Crítico", C.accentYellow] : pct > 60 ? ["Moderado", C.accentOrange] : ["Bien", C.accent];
        return (
          <Box key={b.id}>
            {editBudget === b.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div><Label>Nombre categoría</Label><input value={editBudgetForm.category} onChange={e => setEditBudgetForm(f => ({ ...f, category: e.target.value }))} style={inputSt} /></div>
                <div><Label>Límite ($)</Label><input type="number" value={editBudgetForm.limit} onChange={e => setEditBudgetForm(f => ({ ...f, limit: e.target.value }))} style={inputSt} /></div>
                <div style={{ display: "flex", gap: 8 }}><button onClick={saveEditBudget} style={btnPrimary()}>Guardar</button><button onClick={() => setEditBudget(null)} style={btnGhost}>Cancelar</button></div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <div><div style={{ color: C.text, fontWeight: 700 }}>{b.category}</div><div style={{ color: C.textMuted, fontSize: 12 }}>{fmt(b.spent)} / {fmt(b.limit)}</div></div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Tag color={statusColor}>{status}</Tag>
                    <button onClick={() => startEditBudget(b)} style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 15, padding: "2px 4px" }}>✏️</button>
                    <button onClick={() => deleteBudget(b.id)} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 18 }}>×</button>
                  </div>
                </div>
                <Bar value={b.spent} max={b.limit} h={8} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}><span style={{ color: C.textMuted, fontSize: 11 }}>Disponible: {fmt(b.limit - b.spent)}</span><span style={{ color: statusColor, fontSize: 11, fontWeight: 700 }}>{fmtPct(pct)}</span></div>
              </>
            )}
          </Box>
        );
      })}

      <Box>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 15, marginBottom: 12 }}>Últimos Gastos</div>
        {state.expenses.length === 0 && <div style={{ color: C.textMuted, fontSize: 13 }}>Sin gastos registrados</div>}
        {state.expenses.map(e => { const member = state.members.find(m => m.id === e.memberId); const card = e.cardId ? state.cards.find(c => c.id === e.cardId) : null; return (
          <div key={e.id} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 16 }}>{pmIcon[e.payMethod] || "💵"}</span><div><div style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{e.desc}</div><div style={{ color: C.textMuted, fontSize: 11 }}>{member?.emoji} {member?.name} · {e.category} · {e.date}{card && <span style={{ color: C.accentOrange }}> · {card.name}{e.installments > 1 ? ` (${e.installments}c)` : ""}</span>}</div></div></div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ color: C.accentRed, fontWeight: 700 }}>-{fmt(e.amount)}</div><button onClick={() => deleteExpense(e.id)} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 18 }}>×</button></div>
            </div>
          </div>
        ); })}
      </Box>
    </div>
  );
};

// ── DEUDAS ────────────────────────────────────────────────────────────────────
const Deudas = ({ state, setState }) => {
  const [tab, setTab] = useState("cards");
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [loanForm, setLoanForm] = useState({ name: "", bank: "", holder: 1, principal: "", rate: "", totalInstallments: "", paidInstallments: "" });
  const cardSummary = useMemo(() => state.cards.map(card => { const ap = card.purchases.filter(p => p.paidInstallments < p.installments); const currentDue = ap.reduce((sum, p) => { const rows = buildPurchaseAmortization(p.amount, p.installments, p.zeroInterest ? 0 : card.rate); return sum + (rows[p.paidInstallments]?.pmt || 0); }, 0); const totalBalance = ap.reduce((sum, p) => { const rows = buildPurchaseAmortization(p.amount, p.installments, p.zeroInterest ? 0 : card.rate); return sum + (rows[p.paidInstallments]?.balance || 0) + (rows[p.paidInstallments]?.capital || 0); }, 0); return { ...card, activePurchases: ap, currentDue: Math.round(currentDue), totalBalance: Math.round(totalBalance) }; }), [state.cards]);
  const totalCardDue = cardSummary.reduce((s, c) => s + c.currentDue, 0);
  const totalLoanDue = state.loans.reduce((s, l) => { const { pmt } = buildLoanAmortization(l.principal, l.rate, l.totalInstallments, l.paidInstallments); return s + pmt; }, 0);
  const payPurchaseInstallment = (cardId, purchaseId) => setState(s => ({ ...s, cards: s.cards.map(c => c.id === cardId ? { ...c, purchases: c.purchases.map(p => p.id === purchaseId ? { ...p, paidInstallments: Math.min(p.paidInstallments + 1, p.installments) } : p) } : c) }));
  const payLoanInstallment = (loanId) => setState(s => ({ ...s, loans: s.loans.map(l => l.id === loanId ? { ...l, paidInstallments: Math.min(l.paidInstallments + 1, l.totalInstallments) } : l) }));
  const addLoan = () => { if (!loanForm.name || !loanForm.principal) return; setState(s => ({ ...s, loans: [...s.loans, { id: Date.now(), ...loanForm, holder: +loanForm.holder, principal: +loanForm.principal, rate: +loanForm.rate, totalInstallments: +loanForm.totalInstallments, paidInstallments: +loanForm.paidInstallments || 0 }] })); setLoanForm({ name: "", bank: "", holder: 1, principal: "", rate: "", totalInstallments: "", paidInstallments: "" }); setShowLoanForm(false); };
  const deleteLoan = (id) => setState(s => ({ ...s, loans: s.loans.filter(l => l.id !== id) }));
  const deletePurchase = (cardId, purchaseId) => setState(s => ({ ...s, cards: s.cards.map(c => c.id === cardId ? { ...c, purchases: c.purchases.filter(p => p.id !== purchaseId) } : c) }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>Control de Deudas</div>
        {tab === "loans" && <button onClick={() => setShowLoanForm(!showLoanForm)} style={btnPrimary(C.accentPurple)}>+ Crédito</button>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Box style={{ textAlign: "center", borderColor: C.accentOrange + "44" }}><div style={{ color: C.textMuted, fontSize: 11, fontWeight: 700 }}>CUOTA TARJETAS</div><div style={{ color: C.accentOrange, fontSize: 22, fontWeight: 800, marginTop: 4 }}>{fmt(totalCardDue)}</div><div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>Este mes</div></Box>
        <Box style={{ textAlign: "center", borderColor: C.accentPurple + "44" }}><div style={{ color: C.textMuted, fontSize: 11, fontWeight: 700 }}>CUOTA CRÉDITOS</div><div style={{ color: C.accentPurple, fontSize: 22, fontWeight: 800, marginTop: 4 }}>{fmt(totalLoanDue)}</div><div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>Este mes</div></Box>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {[["cards", "💳 Tarjetas"], ["loans", "🏦 Créditos"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "10px", borderRadius: 10, border: `1.5px solid ${tab === id ? C.accent : C.border}`, background: tab === id ? C.accent + "10" : "transparent", color: tab === id ? C.accent : C.textMuted, fontWeight: 700, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>{label}</button>
        ))}
      </div>
      {tab === "cards" && (<>
        <Box style={{ background: C.accentOrange + "08", borderColor: C.accentOrange + "33" }}>
          <div style={{ color: C.accentOrange, fontWeight: 800, fontSize: 14, marginBottom: 10 }}>📋 Consolidado Mensual Tarjetas</div>
          {cardSummary.map(c => <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ color: C.text, fontSize: 13 }}>{c.name}</span><span style={{ color: C.accentOrange, fontWeight: 700 }}>{fmt(c.currentDue)}</span></div>)}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.accentOrange}33` }}><span style={{ color: C.accentOrange, fontWeight: 800 }}>TOTAL A PAGAR</span><span style={{ color: C.accentOrange, fontWeight: 900, fontSize: 18 }}>{fmt(totalCardDue)}</span></div>
        </Box>
        {cardSummary.map(card => { const member = state.members.find(m => m.id === card.holder); return (
          <Box key={card.id}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <div><div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{card.name}</div><div style={{ color: C.textMuted, fontSize: 12 }}>{member?.emoji} {member?.name} · Tasa {card.rate}% · Cierre día {card.dueDate}</div></div>
              <div style={{ textAlign: "right" }}><div style={{ color: C.accentOrange, fontWeight: 800 }}>{fmt(card.currentDue)}/mes</div><div style={{ color: C.textMuted, fontSize: 11 }}>Saldo: {fmt(card.totalBalance)}</div></div>
            </div>
            <div style={{ color: C.text, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Compras en cuotas:</div>
            {card.purchases.length === 0 && <div style={{ color: C.textMuted, fontSize: 12 }}>Sin compras registradas</div>}
            {card.purchases.map(p => { const effectiveRate = p.zeroInterest ? 0 : card.rate; const rows = buildPurchaseAmortization(p.amount, p.installments, effectiveRate); const remaining = p.installments - p.paidInstallments; const nextRow = rows[p.paidInstallments]; const totalInterest = rows.reduce((s, r) => s + r.interest, 0); const isDone = p.paidInstallments >= p.installments; return (
              <div key={p.id} style={{ background: C.surfaceAlt, borderRadius: 12, padding: 14, marginBottom: 10, border: `1.5px solid ${isDone ? C.accent + "44" : C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div><div style={{ color: isDone ? C.accent : C.text, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>{p.desc} {isDone && "✓"}{p.zeroInterest && <Tag color={C.accent}>0% interés</Tag>}</div><div style={{ color: C.textMuted, fontSize: 11 }}>{p.date} · {fmt(p.amount)} en {p.installments} cuota(s)</div></div>
                  <button onClick={() => deletePurchase(card.id, p.id)} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 18 }}>×</button>
                </div>
                {!isDone && (<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10, marginBottom: 10 }}>
                  <div style={{ background: C.surface, borderRadius: 8, padding: 8, textAlign: "center", border: `1px solid ${C.border}` }}><div style={{ color: C.textMuted, fontSize: 10 }}>Próx cuota</div><div style={{ color: C.accentOrange, fontWeight: 800, fontSize: 13 }}>{fmt(nextRow?.pmt || 0)}</div></div>
                  <div style={{ background: C.surface, borderRadius: 8, padding: 8, textAlign: "center", border: `1px solid ${C.border}` }}><div style={{ color: C.textMuted, fontSize: 10 }}>Cuotas rest.</div><div style={{ color: C.text, fontWeight: 800, fontSize: 13 }}>{remaining}/{p.installments}</div></div>
                  <div style={{ background: C.surface, borderRadius: 8, padding: 8, textAlign: "center", border: `1px solid ${C.border}` }}><div style={{ color: C.textMuted, fontSize: 10 }}>Total int.</div><div style={{ color: C.accentRed, fontWeight: 800, fontSize: 13 }}>{fmtShort(totalInterest)}</div></div>
                </div>)}
                <div style={{ marginBottom: 8 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ color: C.textMuted, fontSize: 11 }}>Progreso de pago</span><span style={{ color: C.accent, fontSize: 11, fontWeight: 700 }}>{p.paidInstallments}/{p.installments}</span></div><Bar value={p.paidInstallments} max={p.installments} color={C.accent} h={6} /></div>
                <AmortTable rows={rows.map((r, i) => ({ ...r, paid: i < p.paidInstallments }))} title={`Amortización: ${p.desc}`} color={C.accentOrange} />
                {!isDone && <button onClick={() => payPurchaseInstallment(card.id, p.id)} style={{ ...btnPrimary(C.accentOrange), width: "100%", marginTop: 10, fontSize: 12 }}>💸 Pagar cuota #{p.paidInstallments + 1}</button>}
              </div>
            ); })}
          </Box>
        ); })}
      </>)}
      {tab === "loans" && (<>
        {showLoanForm && (
          <Box style={{ borderColor: C.accentPurple + "44" }}>
            <div style={{ color: C.accentPurple, fontWeight: 800, marginBottom: 12 }}>Nuevo Crédito</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[["name","Nombre del crédito","text"],["bank","Entidad bancaria","text"],["principal","Monto desembolsado ($)","number"],["rate","Tasa mensual (%)","number"],["totalInstallments","Total de cuotas","number"],["paidInstallments","Cuotas ya pagadas","number"]].map(([k,ph,type]) => <div key={k}><Label>{ph}</Label><input type={type} placeholder={ph} value={loanForm[k]} onChange={e => setLoanForm(f => ({ ...f, [k]: e.target.value }))} style={inputSt} /></div>)}
              <div><Label>Titular</Label><select value={loanForm.holder} onChange={e => setLoanForm(f => ({ ...f, holder: e.target.value }))} style={inputSt}>{state.members.map(m => <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>)}</select></div>
              <div style={{ display: "flex", gap: 8 }}><button onClick={addLoan} style={btnPrimary(C.accentPurple)}>Guardar</button><button onClick={() => setShowLoanForm(false)} style={btnGhost}>Cancelar</button></div>
            </div>
          </Box>
        )}
        {state.loans.map(loan => { const member = state.members.find(m => m.id === loan.holder); const { rows, pmt } = buildLoanAmortization(loan.principal, loan.rate, loan.totalInstallments, loan.paidInstallments); const remaining = loan.totalInstallments - loan.paidInstallments; const currentBalance = rows[loan.paidInstallments]?.balance || 0; const totalInterest = rows.reduce((s, r) => s + r.interest, 0); const paidPct = (loan.paidInstallments / loan.totalInstallments) * 100; return (
          <Box key={loan.id}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <div><div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{loan.name}</div><div style={{ color: C.textMuted, fontSize: 12 }}>{loan.bank} · {member?.emoji} {member?.name} · Tasa {loan.rate}% mensual</div></div>
              <button onClick={() => deleteLoan(loan.id)} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 18 }}>×</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 10 }}><div style={{ color: C.textMuted, fontSize: 10 }}>SALDO ACTUAL</div><div style={{ color: C.accentPurple, fontWeight: 800, fontSize: 16 }}>{fmt(currentBalance)}</div></div>
              <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 10 }}><div style={{ color: C.textMuted, fontSize: 10 }}>CUOTA MENSUAL</div><div style={{ color: C.text, fontWeight: 800, fontSize: 16 }}>{fmt(pmt)}</div></div>
              <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 10 }}><div style={{ color: C.textMuted, fontSize: 10 }}>CUOTAS REST.</div><div style={{ color: C.text, fontWeight: 800, fontSize: 16 }}>{remaining} de {loan.totalInstallments}</div></div>
              <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 10 }}><div style={{ color: C.textMuted, fontSize: 10 }}>TOTAL INTERÉS</div><div style={{ color: C.accentRed, fontWeight: 800, fontSize: 16 }}>{fmt(totalInterest)}</div></div>
            </div>
            <div style={{ marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span style={{ color: C.textMuted, fontSize: 12 }}>Progreso del crédito</span><span style={{ color: C.accentPurple, fontSize: 12, fontWeight: 700 }}>{fmtPct(paidPct)}</span></div><Bar value={loan.paidInstallments} max={loan.totalInstallments} color={C.accentPurple} h={8} /></div>
            <AmortTable rows={rows} title={`Tabla de amortización: ${loan.name}`} color={C.accentPurple} />
            {remaining > 0 && <button onClick={() => payLoanInstallment(loan.id)} style={{ ...btnPrimary(C.accentPurple), width: "100%", marginTop: 12, fontSize: 13 }}>💸 Pagar cuota #{loan.paidInstallments + 1} — {fmt(pmt)}</button>}
            {remaining === 0 && <div style={{ textAlign: "center", color: C.accent, fontWeight: 800, marginTop: 12 }}>✅ Crédito cancelado</div>}
          </Box>
        ); })}
      </>)}
    </div>
  );
};

// ── AHORROS ───────────────────────────────────────────────────────────────────
const Ahorros = ({ state, setState }) => {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", goal: "", current: "" });
  const [contribution, setContribution] = useState({});
  const addSaving = () => { if (!form.name || !form.goal) return; const colors = [C.accent, C.accentBlue, C.accentPurple, C.accentOrange, C.accentYellow, C.accentPink]; setState(s => ({ ...s, savings: [...s.savings, { id: Date.now(), name: form.name, goal: +form.goal, current: +form.current || 0, color: colors[s.savings.length % colors.length] }] })); setForm({ name: "", goal: "", current: "" }); setShowForm(false); };
  const contribute = (id) => { const amt = +contribution[id]; if (!amt || amt <= 0) return; setState(s => ({ ...s, savings: s.savings.map(sv => sv.id === id ? { ...sv, current: Math.min(sv.current + amt, sv.goal) } : sv) })); setContribution(c => ({ ...c, [id]: "" })); };
  const deleteSaving = (id) => setState(s => ({ ...s, savings: s.savings.filter(sv => sv.id !== id) }));
  const totalSaved = state.savings.reduce((s, sv) => s + sv.current, 0);
  const totalGoals = state.savings.reduce((s, sv) => s + sv.goal, 0);
  const monthlyIncome = state.incomes.reduce((s, i) => s + i.amount, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>Metas de Ahorro</div>
        <button onClick={() => setShowForm(!showForm)} style={btnPrimary()}>+ Meta</button>
      </div>
      <Box style={{ borderColor: C.accent, background: C.accent + "08" }}>
        <div style={{ color: C.accent, fontSize: 11, fontWeight: 700, letterSpacing: 1 }}>TOTAL AHORRADO</div>
        <div style={{ color: C.text, fontSize: 30, fontWeight: 900, letterSpacing: -1, marginTop: 4 }}>{fmt(totalSaved)}</div>
        <div style={{ marginTop: 8 }}><Bar value={totalSaved} max={totalGoals} color={C.accent} h={8} /></div>
        <div style={{ color: C.textMuted, fontSize: 12, marginTop: 6 }}>Meta total: {fmt(totalGoals)} · {fmtPct((totalSaved / (totalGoals || 1)) * 100)} completado</div>
      </Box>
      {showForm && (
        <Box style={{ borderColor: C.accent + "44" }}>
          <div style={{ color: C.accent, fontWeight: 800, marginBottom: 12 }}>Nueva Meta de Ahorro</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div><Label>Nombre de la meta</Label><input placeholder="Ej: Vacaciones, fondo emergencia..." value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputSt} /></div>
            <div><Label>Objetivo ($)</Label><input type="number" placeholder="0" value={form.goal} onChange={e => setForm(f => ({ ...f, goal: e.target.value }))} style={inputSt} /></div>
            <div><Label>Ya tengo ahorrado ($)</Label><input type="number" placeholder="0" value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} style={inputSt} /></div>
            <div style={{ display: "flex", gap: 8 }}><button onClick={addSaving} style={btnPrimary()}>Guardar</button><button onClick={() => setShowForm(false)} style={btnGhost}>Cancelar</button></div>
          </div>
        </Box>
      )}
      {state.savings.map(s => { const pct = (s.current / s.goal) * 100; const remaining = s.goal - s.current; const monthsTo = remaining / (monthlyIncome * 0.1 || 1); return (
        <Box key={s.id}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div><div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{s.name}</div><div style={{ color: C.textMuted, fontSize: 12 }}>Faltan {fmt(remaining)}</div></div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><div style={{ color: s.color, fontWeight: 900, fontSize: 20 }}>{fmtPct(pct)}</div><button onClick={() => deleteSaving(s.id)} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 18 }}>×</button></div>
          </div>
          <Bar value={s.current} max={s.goal} color={s.color} h={10} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "12px 0" }}>
            <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 10 }}><div style={{ color: C.textMuted, fontSize: 10 }}>AHORRADO</div><div style={{ color: s.color, fontWeight: 700, fontSize: 14 }}>{fmt(s.current)}</div></div>
            <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 10 }}><div style={{ color: C.textMuted, fontSize: 10 }}>~MESES RESTANTES</div><div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{isFinite(monthsTo) ? Math.ceil(monthsTo) : "—"}</div></div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="number" placeholder="Abono manual ($)" value={contribution[s.id] || ""} onChange={e => setContribution(c => ({ ...c, [s.id]: e.target.value }))} style={{ ...inputSt, flex: 1 }} />
            <button onClick={() => contribute(s.id)} style={{ ...btnPrimary(s.color), whiteSpace: "nowrap", fontSize: 12 }}>+ Abonar</button>
          </div>
        </Box>
      ); })}
    </div>
  );
};

// ── CALENDARIO ────────────────────────────────────────────────────────────────
const Calendario = ({ state, setState }) => {
  const [viewMonth, setViewMonth] = useState(getCurrentMonth());
  const [showForm, setShowForm] = useState(false);
  const [editBill, setEditBill] = useState(null);
  const [confirmPay, setConfirmPay] = useState(null);
  const [form, setForm] = useState({ concept: "", amount: "", dueDay: "1", category: DEFAULT_CATS[0], payMethod: "Transferencia", recurrence: "mensual", color: BILL_COLORS[0] });
  const prevMonth = () => { const [y,m] = viewMonth.split("-").map(Number); const d = new Date(y,m-2,1); setViewMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`); };
  const nextMonth = () => { const [y,m] = viewMonth.split("-").map(Number); const d = new Date(y,m,1); setViewMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`); };
  const getPayment = (bill) => bill.payments.find(p => p.month === viewMonth);
  const markPaid = (billId) => { const bill = state.fixedBills.find(b => b.id === billId); if (!bill) return; const newExpenseId = Date.now(); const today = getToday(); setState(s => ({ ...s, expenses: [{ id: newExpenseId, memberId: s.members[0]?.id || 1, category: bill.category, desc: `${bill.concept} (pago fijo)`, amount: bill.amount, payMethod: bill.payMethod, cardId: null, installments: 1, date: today, fromFixedBill: true }, ...s.expenses], budgets: s.budgets.map(b => b.category === bill.category ? { ...b, spent: b.spent + bill.amount } : b), fixedBills: s.fixedBills.map(b => b.id === billId ? { ...b, payments: [...b.payments.filter(p => p.month !== viewMonth), { id: newExpenseId, month: viewMonth, paid: true, paidDate: today, expenseId: newExpenseId }] } : b) })); setConfirmPay(null); };
  const undoPaid = (billId) => { const bill = state.fixedBills.find(b => b.id === billId); if (!bill) return; const payment = getPayment(bill); if (!payment?.paid) return; setState(s => ({ ...s, expenses: s.expenses.filter(e => e.id !== payment.expenseId), budgets: s.budgets.map(b => b.category === bill.category ? { ...b, spent: Math.max(0, b.spent - bill.amount) } : b), fixedBills: s.fixedBills.map(b => b.id === billId ? { ...b, payments: b.payments.filter(p => p.month !== viewMonth) } : b) })); };
  const saveBill = () => { if (!form.concept || !form.amount) return; if (editBill) { setState(s => ({ ...s, fixedBills: s.fixedBills.map(b => b.id === editBill ? { ...b, ...form, amount: +form.amount, dueDay: +form.dueDay } : b) })); setEditBill(null); } else { setState(s => ({ ...s, fixedBills: [...s.fixedBills, { id: Date.now(), ...form, amount: +form.amount, dueDay: +form.dueDay, payments: [] }] })); } setForm({ concept: "", amount: "", dueDay: "1", category: DEFAULT_CATS[0], payMethod: "Transferencia", recurrence: "mensual", color: BILL_COLORS[0] }); setShowForm(false); };
  const startEdit = (bill) => { setForm({ concept: bill.concept, amount: String(bill.amount), dueDay: String(bill.dueDay), category: bill.category, payMethod: bill.payMethod, recurrence: bill.recurrence, color: bill.color }); setEditBill(bill.id); setShowForm(true); };
  const deleteBill = (id) => setState(s => ({ ...s, fixedBills: s.fixedBills.filter(b => b.id !== id) }));
  const sortedBills = [...state.fixedBills].sort((a, b) => a.dueDay - b.dueDay);
  const isCurrentMonth = viewMonth === getCurrentMonth();
  const totalFixed = sortedBills.reduce((s, b) => s + b.amount, 0);
  const paidThisMonth = sortedBills.filter(b => getPayment(b)?.paid);
  const pendingThisMonth = sortedBills.filter(b => !getPayment(b)?.paid);
  const totalPaid = paidThisMonth.reduce((s, b) => s + b.amount, 0);
  const totalPending = pendingThisMonth.reduce((s, b) => s + b.amount, 0);
  const alerts = isCurrentMonth ? sortedBills.filter(b => !getPayment(b)?.paid).map(b => ({ ...b, daysLeft: getDaysUntilDue(b.dueDay), level: getAlertLevel(getDaysUntilDue(b.dueDay)) })).filter(b => ["vencido","hoy","urgente","pronto"].includes(b.level)).sort((a,b) => a.daysLeft - b.daysLeft) : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>Pagos Fijos</div><div style={{ color: C.textMuted, fontSize: 12 }}>Calendario mensual de obligaciones</div></div>
        <button onClick={() => { setShowForm(!showForm); setEditBill(null); setForm({ concept: "", amount: "", dueDay: "1", category: DEFAULT_CATS[0], payMethod: "Transferencia", recurrence: "mensual", color: BILL_COLORS[0] }); }} style={{ ...btnPrimary(), fontSize: 12, padding: "8px 14px" }}>+ Pago fijo</button>
      </div>
      {alerts.length > 0 && alerts.map(b => { const st = getAlertStyle(b.level); return (<div key={b.id} style={{ background: st.bg, border: `1px solid ${st.color}44`, borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: st.color, flexShrink: 0 }} /><div><div style={{ color: st.color, fontWeight: 800, fontSize: 13 }}>{b.level === "vencido" ? "⚠️" : b.level === "hoy" ? "🔴" : b.level === "urgente" ? "🟠" : "🟡"} {b.concept}</div><div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{b.level === "vencido" ? `Venció hace ${Math.abs(b.daysLeft)} día(s)` : b.level === "hoy" ? "Vence hoy" : `Vence en ${b.daysLeft} día(s) — día ${b.dueDay}`} · {fmt(b.amount)}</div></div></div><Tag color={st.color}>{st.label}</Tag></div>); })}
      <div style={{ display: "flex", alignItems: "center", background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
        <button onClick={prevMonth} style={{ padding: "12px 18px", background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 18, borderRight: `1px solid ${C.border}` }}>‹</button>
        <div style={{ flex: 1, textAlign: "center" }}><div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{fmtMonth(viewMonth)}</div>{isCurrentMonth && <div style={{ color: C.accent, fontSize: 10, fontWeight: 700 }}>MES ACTUAL</div>}</div>
        <button onClick={nextMonth} style={{ padding: "12px 18px", background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 18, borderLeft: `1px solid ${C.border}` }}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <div style={{ background: C.surface, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "12px 10px", textAlign: "center" }}><div style={{ color: C.textMuted, fontSize: 10, fontWeight: 700 }}>TOTAL</div><div style={{ color: C.text, fontWeight: 800, fontSize: 14, marginTop: 3 }}>{fmtShort(totalFixed)}</div></div>
        <div style={{ background: C.surface, border: `1.5px solid ${C.accent}44`, borderRadius: 12, padding: "12px 10px", textAlign: "center" }}><div style={{ color: C.accent, fontSize: 10, fontWeight: 700 }}>PAGADO</div><div style={{ color: C.accent, fontWeight: 800, fontSize: 14, marginTop: 3 }}>{fmtShort(totalPaid)}</div><div style={{ color: C.textMuted, fontSize: 10 }}>{paidThisMonth.length} de {sortedBills.length}</div></div>
        <div style={{ background: C.surface, border: `1.5px solid ${C.accentOrange}44`, borderRadius: 12, padding: "12px 10px", textAlign: "center" }}><div style={{ color: C.accentOrange, fontSize: 10, fontWeight: 700 }}>PENDIENTE</div><div style={{ color: C.accentOrange, fontWeight: 800, fontSize: 14, marginTop: 3 }}>{fmtShort(totalPending)}</div><div style={{ color: C.textMuted, fontSize: 10 }}>{pendingThisMonth.length} pagos</div></div>
      </div>
      {sortedBills.length > 0 && (<div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ color: C.textMuted, fontSize: 12 }}>Progreso del mes</span><span style={{ color: C.accent, fontSize: 12, fontWeight: 700 }}>{fmtPct((paidThisMonth.length / sortedBills.length) * 100)}</span></div><Bar value={paidThisMonth.length} max={sortedBills.length} color={C.accent} h={8} /></div>)}
      {showForm && (
        <Box style={{ borderColor: C.accent + "44" }}>
          <div style={{ color: C.accent, fontWeight: 800, fontSize: 15, marginBottom: 14 }}>{editBill ? "✏️ Editar Pago Fijo" : "➕ Nuevo Pago Fijo"}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div><Label>Concepto</Label><input placeholder="Ej: Arriendo, internet, seguro..." value={form.concept} onChange={e => setForm(f => ({ ...f, concept: e.target.value }))} style={inputSt} /></div>
            <div><Label>Valor ($)</Label><input type="number" placeholder="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={inputSt} /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div><Label>Día límite de pago</Label><input type="number" min="1" max="31" value={form.dueDay} onChange={e => setForm(f => ({ ...f, dueDay: e.target.value }))} style={inputSt} /></div>
              <div><Label>Recurrencia</Label><select value={form.recurrence} onChange={e => setForm(f => ({ ...f, recurrence: e.target.value }))} style={inputSt}><option value="mensual">Mensual</option><option value="bimestral">Bimestral</option><option value="trimestral">Trimestral</option><option value="anual">Anual</option></select></div>
            </div>
            <div><Label>Categoría</Label><select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={inputSt}>{(state.categories || DEFAULT_CATS).map(c => <option key={c}>{c}</option>)}</select></div>
            <div><Label>Método de pago</Label><select value={form.payMethod} onChange={e => setForm(f => ({ ...f, payMethod: e.target.value }))} style={inputSt}>{PAY_TYPES.map(p => <option key={p}>{p}</option>)}</select></div>
            <div><Label>Color</Label><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{BILL_COLORS.map(col => <button key={col} onClick={() => setForm(f => ({ ...f, color: col }))} style={{ width: 30, height: 30, borderRadius: "50%", background: col, border: form.color === col ? `3px solid ${C.text}` : "3px solid transparent", cursor: "pointer" }} />)}</div></div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}><button onClick={saveBill} style={btnPrimary()}>{editBill ? "Actualizar" : "Guardar"}</button><button onClick={() => { setShowForm(false); setEditBill(null); }} style={btnGhost}>Cancelar</button></div>
          </div>
        </Box>
      )}
      {confirmPay !== null && (() => { const bill = state.fixedBills.find(b => b.id === confirmPay); if (!bill) return null; return (
        <div style={{ position: "fixed", inset: 0, background: "#000000BB", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: C.surface, border: `1.5px solid ${bill.color}66`, borderRadius: 20, padding: 24, maxWidth: 340, width: "100%" }}>
            <div style={{ fontSize: 36, textAlign: "center", marginBottom: 12 }}>✅</div>
            <div style={{ color: C.text, fontWeight: 800, fontSize: 16, textAlign: "center", marginBottom: 6 }}>Confirmar pago</div>
            <div style={{ color: C.textMuted, fontSize: 13, textAlign: "center", marginBottom: 18, lineHeight: 1.6 }}>¿Marcar <strong style={{ color: bill.color }}>{bill.concept}</strong> como pagado?<br />Se registrará <strong style={{ color: C.accent }}>{fmt(bill.amount)}</strong> en tus gastos<br />y se descontará del presupuesto de <strong>{bill.category}</strong>.</div>
            <div style={{ display: "flex", gap: 10 }}><button onClick={() => markPaid(confirmPay)} style={{ ...btnPrimary(), flex: 1 }}>✓ Sí, está pagado</button><button onClick={() => setConfirmPay(null)} style={{ ...btnGhost, flex: 1 }}>Cancelar</button></div>
          </div>
        </div>
      ); })()}
      {sortedBills.length === 0 && <Box style={{ textAlign: "center", padding: 40 }}><div style={{ fontSize: 40, marginBottom: 10 }}>📅</div><div style={{ color: C.textMuted, fontSize: 14 }}>Sin pagos fijos registrados.<br />Agrega tu primer pago fijo.</div></Box>}
      {sortedBills.map(bill => { const payment = getPayment(bill); const isPaid = payment?.paid; const daysLeft = isCurrentMonth ? getDaysUntilDue(bill.dueDay) : null; const level = isCurrentMonth && !isPaid ? getAlertLevel(daysLeft) : null; const alertSt = level ? getAlertStyle(level) : null; return (
        <div key={bill.id} style={{ background: C.surface, border: `1.5px solid ${isPaid ? C.accent + "44" : alertSt?.color ? alertSt.color + "33" : C.border}`, borderRadius: 16, overflow: "hidden", opacity: isPaid ? 0.85 : 1, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
          <div style={{ height: 4, background: isPaid ? C.accent : bill.color }} />
          <div style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button onClick={() => isPaid ? undoPaid(bill.id) : setConfirmPay(bill.id)} style={{ width: 28, height: 28, borderRadius: 8, border: `2px solid ${isPaid ? C.accent : bill.color}`, background: isPaid ? C.accent : "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#fff", transition: "all .2s", flexShrink: 0 }}>{isPaid ? "✓" : ""}</button>
                <div><div style={{ color: isPaid ? C.textMuted : C.text, fontWeight: 800, fontSize: 14, textDecoration: isPaid ? "line-through" : "none" }}>{bill.concept}</div><div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{bill.category} · {bill.payMethod} · Día {bill.dueDay}{bill.recurrence !== "mensual" && <span style={{ color: bill.color }}> · {bill.recurrence}</span>}</div></div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <div style={{ color: isPaid ? C.accent : C.text, fontWeight: 900, fontSize: 16 }}>{fmt(bill.amount)}</div>
                {isPaid ? <Tag color={C.accent}>✓ Pagado {payment.paidDate?.slice(5)}</Tag> : level && alertSt ? <Tag color={alertSt.color}>{alertSt.label}</Tag> : !isCurrentMonth ? <Tag color={C.textSub}>Pendiente</Tag> : <Tag color={C.textMuted}>En {daysLeft}d</Tag>}
              </div>
            </div>
            {isPaid && <div style={{ background: C.accent + "10", border: `1px solid ${C.accent}33`, borderRadius: 8, padding: "8px 12px", marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ color: C.accent, fontSize: 12, fontWeight: 700 }}>✅ Registrado en gastos y presupuesto</div><div style={{ color: C.textMuted, fontSize: 11 }}>Presupuesto de {bill.category} actualizado</div></div><button onClick={() => undoPaid(bill.id)} style={{ background: "transparent", border: `1px solid ${C.accentRed}44`, color: C.accentRed, borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Deshacer</button></div>}
            {!isPaid && level && level !== "ok" && isCurrentMonth && <div style={{ background: alertSt.bg, border: `1px solid ${alertSt.color}33`, borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}><div style={{ color: alertSt.color, fontSize: 12, fontWeight: 700 }}>{level === "vencido" ? `⚠️ Venció hace ${Math.abs(daysLeft)} día(s)` : level === "hoy" ? "🔴 Vence hoy — ¡paga cuanto antes!" : level === "urgente" ? `🟠 Vence en ${daysLeft} día(s)` : `🟡 Vence en ${daysLeft} días`}</div></div>}
            <div style={{ display: "flex", gap: 8 }}>
              {!isPaid && <button onClick={() => setConfirmPay(bill.id)} style={{ flex: 1, padding: "9px", borderRadius: 10, border: `1.5px solid ${bill.color}55`, background: bill.color + "10", color: bill.color, fontWeight: 700, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>✓ Marcar como pagado</button>}
              <button onClick={() => startEdit(bill)} style={{ padding: "9px 12px", borderRadius: 10, border: `1.5px solid ${C.border}`, background: "transparent", color: C.textMuted, fontWeight: 600, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>✏️</button>
              <button onClick={() => deleteBill(bill.id)} style={{ padding: "9px 12px", borderRadius: 10, border: `1.5px solid ${C.accentRed}33`, background: "transparent", color: C.accentRed, fontWeight: 600, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>🗑️</button>
            </div>
          </div>
        </div>
      ); })}
    </div>
  );
};

// ── ASESOR ────────────────────────────────────────────────────────────────────
const Asesor = ({ state }) => {
  const [topic, setTopic] = useState("");
  const [copied, setCopied] = useState(false);

  const totalIncome = state.incomes.reduce((s, i) => s + i.amount, 0);
  const totalSpent = state.budgets.reduce((s, b) => s + b.spent, 0);
  const totalCardDue = state.cards.reduce((cs, card) => cs + (card.purchases || []).filter(p => p.paidInstallments < p.installments).reduce((sum, p) => { const rows = buildPurchaseAmortization(p.amount, p.installments, p.zeroInterest ? 0 : card.rate); return sum + (rows[p.paidInstallments]?.pmt || 0); }, 0), 0);
  const totalLoanDue = state.loans.reduce((s, l) => { const { pmt } = buildLoanAmortization(l.principal, l.rate, l.totalInstallments); return s + pmt; }, 0);
  const debtRatio = ((totalCardDue + totalLoanDue) / (totalIncome || 1)) * 100;
  const totalSaved = state.savings.reduce((s, sv) => s + sv.current, 0);

  const buildPrompt = () => {
    const miembros = state.members.map(m => m.name).join(" y ");
    const ingresos = state.incomes.map(i => {
      const m = state.members.find(mb => mb.id === i.memberId);
      return `  · ${m?.name}: ${i.desc} — ${fmt(i.amount)} (${i.type})`;
    }).join("\n") || "  Sin ingresos registrados";

    const presupuestos = state.budgets.map(b =>
      `  · ${b.category}: gastado ${fmt(b.spent)} de ${fmt(b.limit)} (${fmtPct((b.spent / (b.limit||1)) * 100)})`
    ).join("\n") || "  Sin presupuestos";

    const tarjetas = state.cards.map(c => {
      const due = (c.purchases || []).filter(p => p.paidInstallments < p.installments).reduce((sum, p) => {
        const rows = buildPurchaseAmortization(p.amount, p.installments, c.rate);
        return sum + (rows[p.paidInstallments]?.pmt || 0);
      }, 0);
      return `  · ${c.name}: cuota mes ${fmt(Math.round(due))}, tasa ${c.rate}% mensual`;
    }).join("\n") || "  Sin tarjetas";

    const creditos = state.loans.map(l => {
      const { pmt } = buildLoanAmortization(l.principal, l.rate, l.totalInstallments, l.paidInstallments);
      const remaining = l.totalInstallments - l.paidInstallments;
      return `  · ${l.name} (${l.bank}): cuota ${fmt(pmt)}/mes, ${remaining} cuotas restantes, tasa ${l.rate}% mensual`;
    }).join("\n") || "  Sin créditos";

    const ahorros = state.savings.map(s =>
      `  · ${s.name}: ${fmt(s.current)} de ${fmt(s.goal)} (${fmtPct((s.current / (s.goal||1)) * 100)})`
    ).join("\n") || "  Sin metas de ahorro";

    const pagos = (state.fixedBills || []).map(b =>
      `  · ${b.concept}: ${fmt(b.amount)}/mes (día ${b.dueDay})`
    ).join("\n") || "  Sin pagos fijos";

    return `Hola Claude, soy ${miembros}, una pareja de trabajadores independientes en Medellín, Colombia. Necesito tu asesoría financiera basada en mis datos reales del hogar.

═══ DATOS FINANCIEROS DEL HOGAR ═══

📊 RESUMEN
  · Ingreso total mensual: ${fmt(totalIncome)}
  · Gasto mensual total: ${fmt(totalSpent)} (${fmtPct((totalSpent/(totalIncome||1))*100)} del ingreso)
  · Cuotas tarjetas: ${fmt(Math.round(totalCardDue))}/mes
  · Cuotas créditos: ${fmt(Math.round(totalLoanDue))}/mes
  · Índice de endeudamiento: ${fmtPct(debtRatio)} del ingreso
  · Total ahorrado: ${fmt(totalSaved)}
  · Flujo libre: ${fmt(totalIncome - totalSpent - totalCardDue - totalLoanDue)}

💰 INGRESOS
${ingresos}

📋 PRESUPUESTOS
${presupuestos}

💳 TARJETAS DE CRÉDITO
${tarjetas}

🏦 CRÉDITOS
${creditos}

🐷 AHORROS
${ahorros}

📅 PAGOS FIJOS MENSUALES
${pagos}

═══════════════════════════════════

🎯 TEMA QUE QUIERO ANALIZAR:
${topic || "(describe aquí tu pregunta o tema)"}

Por favor dame consejos concretos, accionables y con números específicos basados en mi situación real.`;
  };

  const openClaude = () => {
    const prompt = buildPrompt();
    const encoded = encodeURIComponent(prompt);
    // Open Claude.ai with the prompt pre-filled
    window.open(`https://claude.ai/new?q=${encoded}`, "_blank");
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>💡 Asesor Financiero IA</div>
        <div style={{ color: C.textMuted, fontSize: 12 }}>Consulta a Claude con tus datos reales del hogar</div>
      </div>

      {/* How it works */}
      <Box style={{ background: C.accent + "08", borderColor: C.accent + "33" }}>
        <div style={{ color: C.accent, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>¿Cómo funciona?</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {["1️⃣ Escribe el tema o pregunta que quieres analizar", "2️⃣ La app arma un mensaje con todos tus datos financieros reales", "3️⃣ Te abre Claude.ai con todo listo — solo da clic en enviar"].map((s, i) => (
            <div key={i} style={{ color: C.textMuted, fontSize: 13 }}>{s}</div>
          ))}
        </div>
      </Box>

      {/* Topic input */}
      <Box>
        <Label>¿Sobre qué quieres asesoría hoy?</Label>
        <textarea
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder={"Ej: ¿Cómo puedo pagar mis deudas más rápido?\nEj: ¿Estamos ahorrando suficiente para emergencias?\nEj: ¿Cuánto deberíamos destinar a inversión?\nEj: Analiza si nuestro presupuesto está bien distribuido"}
          rows={4}
          style={{ ...inputSt, resize: "none", lineHeight: 1.6, fontSize: 13 }}
        />
      </Box>

      {/* Preview of what will be sent */}
      <Box style={{ background: C.surfaceAlt, border: `1.5px solid ${C.border}` }}>
        <div style={{ color: C.textMuted, fontWeight: 700, fontSize: 12, marginBottom: 8 }}>📋 RESUMEN QUE SE ENVIARÁ A CLAUDE</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {[
            ["Ingresos", fmt(totalIncome)],
            ["Gastos", fmt(totalSpent)],
            ["Cuotas deudas/mes", fmt(Math.round(totalCardDue + totalLoanDue))],
            ["Endeudamiento", fmtPct(debtRatio)],
            ["Total ahorrado", fmt(totalSaved)],
            ["Tarjetas", `${state.cards.length} tarjeta(s)`],
            ["Créditos", `${state.loans.length} crédito(s)`],
            ["Pagos fijos", `${(state.fixedBills||[]).length} pago(s)`],
          ].map(([label, value]) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.textMuted, fontSize: 12 }}>{label}</span>
              <span style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      </Box>

      {/* Action buttons */}
      <button onClick={openClaude} style={{
        background: C.accent, color: "#fff", border: "none", borderRadius: 12,
        padding: "15px", fontSize: 15, fontWeight: 800, cursor: "pointer",
        fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        🚀 Abrir Claude con mis datos
      </button>

      <button onClick={copyPrompt} style={{
        background: copied ? C.accent + "10" : "transparent",
        color: copied ? C.accent : C.textMuted,
        border: `1.5px solid ${copied ? C.accent : C.border}`,
        borderRadius: 12, padding: "12px", fontSize: 13, fontWeight: 700,
        cursor: "pointer", fontFamily: "inherit",
      }}>
        {copied ? "✓ Copiado al portapapeles" : "📋 Copiar mensaje (para pegarlo manualmente)"}
      </button>

      <div style={{ color: C.textMuted, fontSize: 11, textAlign: "center", lineHeight: 1.6 }}>
        Si Claude.ai no abre automáticamente con el mensaje,<br />usa el botón "Copiar" y pégalo en claude.ai
      </div>

      {/* Alertas automáticas */}
      <div style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>⚠️ Alertas del Sistema</div>
      {debtRatio > 40 && <Box style={{ borderColor: C.accentRed + "44", background: C.accentRed + "08" }}><div style={{ color: C.accentRed, fontWeight: 800 }}>🚨 Endeudamiento crítico</div><div style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>Tus cuotas representan el {fmtPct(debtRatio)} del ingreso. Lo saludable es máximo 35%.</div></Box>}
      {totalSaved < totalIncome * 3 && <Box style={{ borderColor: C.accentBlue + "44", background: C.accentBlue + "08" }}><div style={{ color: C.accentBlue, fontWeight: 800 }}>🛡️ Fondo de emergencia insuficiente</div><div style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>Como independientes necesitan mínimo 6 meses de gastos ({fmt(totalSpent * 6)}) en reserva.</div></Box>}
      {state.incomes.filter(i => i.type === "variable").reduce((s, i) => s + i.amount, 0) > totalIncome * 0.4 && <Box style={{ borderColor: C.accentYellow + "44", background: C.accentYellow + "08" }}><div style={{ color: C.accentYellow, fontWeight: 800 }}>📊 Alta dependencia de ingresos variables</div><div style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>Más del 40% de los ingresos son variables. Planea el presupuesto solo con los ingresos fijos.</div></Box>}
    </div>
  );
};

// ── ROOT APP WITH FIREBASE ────────────────────────────────────────────────────
// ── CONFIGURACION ─────────────────────────────────────────────────────────────
const Configuracion = ({ state, setState }) => {
  const [configTab, setConfigTab] = useState("usuarios");
  const [memberForms, setMemberForms] = useState(state.members.map(m => ({ ...m })));
  const [savedMsg, setSavedMsg] = useState(null);
  const [showCardForm, setShowCardForm] = useState(false);
  const [editCardId, setEditCardId] = useState(null);
  const [cardForm, setCardForm] = useState({ name: "", holder: 1, limit: "", rate: "", dueDate: "" });
  const EMOJIS = ["👨","👩","👦","👧","🧑","👴","👵","🧔","👱","🧓"];
  const MEMBER_COLORS = [C.accentBlue, C.accentPink, C.accentPurple, C.accentOrange, C.accentYellow, C.accent];

  const saveMember = (id) => {
    const mf = memberForms.find(m => m.id === id);
    if (!mf?.name.trim()) return;
    setState(s => ({ ...s, members: s.members.map(m => m.id === id ? { ...m, name: mf.name, emoji: mf.emoji, color: mf.color } : m) }));
    setSavedMsg(id);
    setTimeout(() => setSavedMsg(null), 2000);
  };

  const startEditCard = (c) => {
    setCardForm({ name: c.name, holder: c.holder, limit: String(c.limit), rate: String(c.rate), dueDate: String(c.dueDate) });
    setEditCardId(c.id);
    setShowCardForm(true);
  };

  const saveCard = () => {
    if (!cardForm.name || !cardForm.limit) return;
    if (editCardId) {
      setState(s => ({ ...s, cards: s.cards.map(c => c.id === editCardId ? { ...c, name: cardForm.name, holder: +cardForm.holder, limit: +cardForm.limit, rate: +cardForm.rate || 2.0, dueDate: cardForm.dueDate } : c) }));
    } else {
      setState(s => ({ ...s, cards: [...s.cards, { id: Date.now(), name: cardForm.name, holder: +cardForm.holder, limit: +cardForm.limit, rate: +cardForm.rate || 2.0, dueDate: cardForm.dueDate, purchases: [] }] }));
    }
    setCardForm({ name: "", holder: 1, limit: "", rate: "", dueDate: "" });
    setShowCardForm(false);
    setEditCardId(null);
  };

  const deleteCard = (id) => setState(s => ({ ...s, cards: s.cards.filter(c => c.id !== id) }));

  const tabBtn = (id, label, icon) => (
    <button onClick={() => setConfigTab(id)} style={{
      flex: 1, padding: "11px 8px", borderRadius: 10, fontFamily: "inherit", cursor: "pointer", fontWeight: 700, fontSize: 13,
      border: `1.5px solid ${configTab === id ? C.accent : C.border}`,
      background: configTab === id ? C.accent + "10" : "transparent",
      color: configTab === id ? C.accent : C.textMuted,
    }}>{icon} {label}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ color: C.text, fontSize: 20, fontWeight: 800 }}>Configuración</div>
        <div style={{ color: C.textMuted, fontSize: 12 }}>Ajustes del hogar</div>
      </div>

      {/* Tab selector */}
      <div style={{ display: "flex", gap: 8 }}>
        {tabBtn("usuarios", "Usuarios", "👥")}
        {tabBtn("tarjetas", "Tarjetas", "💳")}
      </div>

      {/* ── PESTAÑA USUARIOS ── */}
      {configTab === "usuarios" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {memberForms.map((mf, idx) => (
            <Box key={mf.id} style={{ borderColor: mf.color + "44" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: mf.color + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>{mf.emoji}</div>
                <div>
                  <div style={{ color: mf.color, fontWeight: 800, fontSize: 16 }}>{state.members.find(m => m.id === mf.id)?.name}</div>
                  <div style={{ color: C.textMuted, fontSize: 11 }}>Miembro {idx + 1} del hogar</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div><Label>Nombre</Label>
                  <input value={mf.name} onChange={e => setMemberForms(fs => fs.map(f => f.id === mf.id ? { ...f, name: e.target.value } : f))} style={inputSt} />
                </div>
                <div><Label>Emoji</Label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {EMOJIS.map(em => (
                      <button key={em} onClick={() => setMemberForms(fs => fs.map(f => f.id === mf.id ? { ...f, emoji: em } : f))}
                        style={{ width: 38, height: 38, borderRadius: 8, border: `2px solid ${mf.emoji === em ? mf.color : C.border}`, background: mf.emoji === em ? mf.color + "15" : "transparent", cursor: "pointer", fontSize: 20 }}>{em}
                      </button>
                    ))}
                  </div>
                </div>
                <div><Label>Color</Label>
                  <div style={{ display: "flex", gap: 8 }}>
                    {MEMBER_COLORS.map(col => (
                      <button key={col} onClick={() => setMemberForms(fs => fs.map(f => f.id === mf.id ? { ...f, color: col } : f))}
                        style={{ width: 30, height: 30, borderRadius: "50%", background: col, border: mf.color === col ? `3px solid ${C.text}` : "3px solid transparent", cursor: "pointer" }} />
                    ))}
                  </div>
                </div>
                <button onClick={() => saveMember(mf.id)} style={{ ...btnPrimary(mf.color), width: "100%", marginTop: 4 }}>
                  {savedMsg === mf.id ? "✓ Guardado" : "Guardar cambios"}
                </button>
              </div>
            </Box>
          ))}
        </div>
      )}

      {/* ── PESTAÑA TARJETAS ── */}
      {configTab === "tarjetas" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <button onClick={() => { setShowCardForm(true); setEditCardId(null); setCardForm({ name: "", holder: 1, limit: "", rate: "", dueDate: "" }); }}
            style={{ ...btnPrimary(C.accentOrange), width: "100%" }}>
            + Nueva Tarjeta de Crédito
          </button>

          {showCardForm && (
            <Box style={{ borderColor: C.accentOrange + "44" }}>
              <div style={{ color: C.accentOrange, fontWeight: 800, fontSize: 15, marginBottom: 12 }}>
                {editCardId ? "✏️ Editar Tarjeta" : "➕ Nueva Tarjeta"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div><Label>Nombre de la tarjeta</Label>
                  <input placeholder="Ej: Visa Bancolombia" value={cardForm.name} onChange={e => setCardForm(f => ({ ...f, name: e.target.value }))} style={inputSt} />
                </div>
                <div><Label>Titular</Label>
                  <select value={cardForm.holder} onChange={e => setCardForm(f => ({ ...f, holder: e.target.value }))} style={inputSt}>
                    {state.members.map(m => <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>)}
                  </select>
                </div>
                <div><Label>Cupo total ($)</Label>
                  <input type="number" placeholder="0" value={cardForm.limit} onChange={e => setCardForm(f => ({ ...f, limit: e.target.value }))} style={inputSt} />
                </div>
                <div><Label>Tasa de interés mensual (%)</Label>
                  <input type="number" placeholder="2.0" step="0.1" value={cardForm.rate} onChange={e => setCardForm(f => ({ ...f, rate: e.target.value }))} style={inputSt} />
                </div>
                <div><Label>Día de cierre</Label>
                  <input type="number" min="1" max="31" placeholder="25" value={cardForm.dueDate} onChange={e => setCardForm(f => ({ ...f, dueDate: e.target.value }))} style={inputSt} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={saveCard} style={btnPrimary(C.accentOrange)}>{editCardId ? "Actualizar" : "Guardar"}</button>
                  <button onClick={() => { setShowCardForm(false); setEditCardId(null); }} style={btnGhost}>Cancelar</button>
                </div>
              </div>
            </Box>
          )}

          {state.cards.length === 0 && !showCardForm && (
            <Box style={{ textAlign: "center", padding: 32 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>💳</div>
              <div style={{ color: C.textMuted, fontSize: 14 }}>Sin tarjetas registradas.<br />Agrega tu primera tarjeta arriba.</div>
            </Box>
          )}

          {state.cards.map(c => {
            const holder = state.members.find(m => m.id === c.holder);
            const activePurchases = (c.purchases || []).filter(p => p.paidInstallments < p.installments);
            const totalBalance = activePurchases.reduce((sum, p) => {
              const rows = buildPurchaseAmortization(p.amount, p.installments, p.zeroInterest ? 0 : c.rate);
              return sum + (rows[p.paidInstallments]?.balance || 0);
            }, 0);
            const utilization = c.limit > 0 ? (totalBalance / c.limit) * 100 : 0;
            return (
              <Box key={c.id} style={{ borderColor: C.accentOrange + "33" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div>
                    <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{c.name}</div>
                    <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>{holder?.emoji} {holder?.name}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => startEditCard(c)} style={{ background: C.accent + "12", border: `1px solid ${C.accent}33`, color: C.accent, borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>✏️ Editar</button>
                    <button onClick={() => deleteCard(c.id)} style={{ background: C.accentRed + "12", border: `1px solid ${C.accentRed}33`, color: C.accentRed, borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Eliminar</button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 8 }}>
                    <div style={{ color: C.textMuted, fontSize: 10 }}>CUPO</div>
                    <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{fmt(c.limit)}</div>
                  </div>
                  <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 8 }}>
                    <div style={{ color: C.textMuted, fontSize: 10 }}>TASA MENSUAL</div>
                    <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{c.rate}%</div>
                  </div>
                  <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 8 }}>
                    <div style={{ color: C.textMuted, fontSize: 10 }}>CIERRE DÍA</div>
                    <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{c.dueDate}</div>
                  </div>
                  <div style={{ background: C.surfaceAlt, borderRadius: 8, padding: 8 }}>
                    <div style={{ color: C.textMuted, fontSize: 10 }}>COMPRAS ACTIVAS</div>
                    <div style={{ color: C.accentOrange, fontWeight: 700, fontSize: 13 }}>{activePurchases.length}</div>
                  </div>
                </div>
                <div style={{ marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ color: C.textMuted, fontSize: 11 }}>Utilización del cupo</span>
                    <span style={{ color: utilization > 70 ? C.accentRed : C.accent, fontSize: 11, fontWeight: 700 }}>{fmtPct(utilization)}</span>
                  </div>
                  <Bar value={totalBalance} max={c.limit} color={C.accentOrange} h={6} />
                </div>
              </Box>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [state, setStateLocal] = useState(INIT);
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState("dashboard");

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  // Firestore real-time listener — fires every time ANY user saves data
  useEffect(() => {
    if (!user) return;
    const docRef = doc(db, "hogar", "finhogar");
    const unsub = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setStateLocal(prev => ({ ...INIT, ...snap.data() }));
      } else {
        // First time: write initial state
        setDoc(docRef, INIT);
      }
    });
    return unsub;
  }, [user]);

  // Debounced save to Firestore on every state change
  const saveTimeout = useState(null);
  const setState = useCallback((updater) => {
    setStateLocal(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      // Save to Firestore (debounced 600ms)
      if (saveTimeout[0]) clearTimeout(saveTimeout[0]);
      saveTimeout[0] = setTimeout(() => {
        setSyncing(true);
        setDoc(doc(db, "hogar", "finhogar"), next)
          .then(() => setSyncing(false))
          .catch(() => setSyncing(false));
      }, 600);
      return next;
    });
  }, []);

  const handleLogin = async () => {
    setLoginLoading(true);
    try { await signInWithPopup(auth, googleProvider); }
    catch (e) { console.error(e); }
    setLoginLoading(false);
  };

  const handleLogout = () => signOut(auth);

  if (authLoading) return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: C.textMuted, fontSize: 14 }}>Cargando...</div>
    </div>
  );

  if (!user) return <LoginScreen onLogin={handleLogin} loading={loginLoading} />;

  // ── Verificar correo autorizado ──────────────────────────────────────────────
  if (!ALLOWED_EMAILS.includes(user.email)) {
    return <AccessDenied user={user} onLogout={handleLogout} />;
  }

  const nav = [
    { id: "dashboard", icon: "🏠", label: "Inicio" },
    { id: "ingresos", icon: "💰", label: "Ingresos" },
    { id: "gastos", icon: "🛒", label: "Gastos" },
    { id: "deudas", icon: "💳", label: "Deudas" },
    { id: "ahorros", icon: "🐷", label: "Ahorros" },
    { id: "calendario", icon: "📅", label: "Pagos" },
    { id: "asesor", icon: "💡", label: "Asesor" },
    { id: "config", icon: "⚙️", label: "Config" },
  ];

  const views = { dashboard: Dashboard, ingresos: Ingresos, gastos: Gastos, deudas: Deudas, ahorros: Ahorros, calendario: Calendario, asesor: Asesor, config: Configuracion };
  const View = views[tab];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Sans', -apple-system, sans-serif", color: C.text, display: "flex", flexDirection: "column", maxWidth: 520, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ padding: "12px 18px 10px", background: C.surface, borderBottom: `1.5px solid ${C.border}`, position: "sticky", top: 0, zIndex: 10, boxShadow: "0 1px 0 rgba(0,0,0,0.04)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🏡</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: -0.3 }}>FinHogar</div>
              <div style={{ fontSize: 10, color: C.textMuted, display: "flex", alignItems: "center", gap: 4 }}>
                {user.displayName?.split(" ")[0] || user.email}
                {syncing && <span style={{ color: C.accentBlue }}>· guardando...</span>}
                {!syncing && <span style={{ color: C.accent }}>· ✓ sincronizado</span>}
              </div>
            </div>
          </div>
          <button onClick={handleLogout} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", color: C.textMuted, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>Salir</button>
        </div>
      </div>

      {/* Content — paddingBottom accounts for nav bar height + safe area */}
      <div style={{ flex: 1, padding: "18px 14px 0", paddingBottom: "calc(72px + env(safe-area-inset-bottom, 0px))", overflowY: "auto" }}>
        <View state={state} setState={setState} />
      </div>

      {/* Bottom Nav — fixed at very bottom, respects iPhone home indicator */}
      <div style={{
        position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 520, background: C.surface,
        borderTop: `1.5px solid ${C.border}`,
        paddingTop: 6, paddingBottom: `calc(8px + env(safe-area-inset-bottom, 0px))`,
        display: "flex", justifyContent: "space-around", zIndex: 100,
        boxShadow: "0 -2px 12px rgba(0,0,0,0.06)",
      }}>
        {nav.map(n => <NavBtn key={n.id} {...n} active={tab === n.id} onClick={() => setTab(n.id)} />)}
      </div>
    </div>
  );
}
