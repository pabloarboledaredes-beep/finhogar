# FinHogar 🏡

App de control financiero del hogar para Pablo & Esposa.  
Sincronización en tiempo real vía Firebase · Login con Google · Desplegada en Vercel.

---

## 🚀 Publicar en Vercel (paso a paso)

### Paso 1 — Instalar herramientas (una sola vez)

Necesitas tener instalado **Node.js** en tu computador.  
Descárgalo en: https://nodejs.org (elige la versión LTS)

Verifica que quedó instalado abriendo una terminal y escribiendo:
```
node --version
```

### Paso 2 — Subir el código a GitHub

1. Ve a https://github.com y crea una cuenta (si no tienes)
2. Clic en **"New repository"**
3. Nombre: `finhogar` → clic **"Create repository"**
4. En tu computador, abre una terminal en la carpeta `finhogar` y ejecuta:

```bash
npm install
git init
git add .
git commit -m "FinHogar v1"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/finhogar.git
git push -u origin main
```
(Reemplaza `TU_USUARIO` con tu nombre de usuario de GitHub)

### Paso 3 — Publicar en Vercel

1. Ve a https://vercel.com y crea cuenta (usa tu cuenta de GitHub para registrarte)
2. Clic en **"Add New Project"**
3. Selecciona el repositorio `finhogar`
4. Vercel detecta automáticamente que es Vite/React
5. Clic **"Deploy"**
6. En ~2 minutos tendrás tu URL: `https://finhogar-xxx.vercel.app`

### Paso 4 — Autorizar el dominio en Firebase

Para que el login con Google funcione en producción:

1. Ve a https://console.firebase.google.com → tu proyecto `finhogar-4d50c`
2. **Authentication → Settings → Authorized domains**
3. Clic **"Add domain"**
4. Pega tu URL de Vercel (ej: `finhogar-xxx.vercel.app`)
5. Guarda

### Paso 5 — ¡Listo! 🎉

Comparte el link con tu esposa. Los dos inician sesión con Google y los datos se sincronizan en tiempo real automáticamente.

---

## 🔄 Cómo actualizar la app después

Cuando quieras hacer cambios, solo ejecuta:
```bash
git add .
git commit -m "descripción del cambio"
git push
```
Vercel redesplegará automáticamente en ~1 minuto.

---

## 📱 Instalarla como app en el celular

En Chrome (Android) o Safari (iOS):
1. Abre la URL de Vercel en el navegador
2. Menú → **"Agregar a pantalla de inicio"**
3. La app aparecerá como un ícono nativo en tu celular

---

## 🔒 Seguridad

Los datos están guardados en Firestore de Google (Firebase).  
Solo las cuentas de Google autorizadas pueden acceder.  
Para agregar más usuarios autorizados, ve a Firebase → Firestore → Rules y modifica según necesites.
