# Skill: /audit-security

Ejecuta una auditoría completa de seguridad del sistema NanoClaw. Comprueba cada vector de ataque,
interpreta los resultados, propone correcciones y genera un informe final en `~/audit-report.md`.

No pidas confirmación antes de ejecutar comandos de lectura. Sí pide confirmación antes de
modificar cualquier archivo de configuración.

---

## Fase 0: Setup del informe

Crea el archivo de informe donde irás registrando hallazgos:

```bash
cat > ~/audit-report.md << 'EOF'
# Informe de Auditoría de Seguridad — NanoClaw
**Fecha:** $(date +"%Y-%m-%d %H:%M")
**Host:** $(hostname)

## Resumen ejecutivo
<!-- Se completa al final -->

## Hallazgos
EOF
```

Define estas funciones de logging para usar a lo largo de la auditoría:

```bash
# Uso: log_ok "mensaje"   log_warn "mensaje"   log_fail "mensaje"
log_ok()   { echo "✅ OK     — $1" | tee -a ~/audit-report.md; }
log_warn() { echo "⚠️  WARN   — $1" | tee -a ~/audit-report.md; }
log_fail() { echo "❌ FAIL   — $1" | tee -a ~/audit-report.md; }
log_info() { echo "ℹ️  INFO   — $1" | tee -a ~/audit-report.md; }
log_section() { echo -e "\n### $1" | tee -a ~/audit-report.md; }
```

---

## Fase 1: Inventario del sistema

```bash
log_section "1. Inventario del sistema"

node --version
docker --version
uname -r
lsb_release -a 2>/dev/null || cat /etc/os-release

# NanoClaw: detectar versión del fork
cd ~/nanoclaw
git log --oneline -1
```

**Criterios de evaluación:**
- Node.js >= 20.x → `log_ok`, si es menor → `log_warn "Node.js desactualizado: actualizar a 20.x+"`
- Docker >= 24.x → `log_ok`, si es menor → `log_warn "Docker desactualizado"`
- Ubuntu >= 22.04 → `log_ok`, si es menor → `log_warn "OS desactualizado"`

---

## Fase 2: Código fuente — integridad y malware

```bash
log_section "2. Auditoría del código fuente"
cd ~/nanoclaw
```

### 2.1 Integridad vs upstream

```bash
# Añadir upstream si no existe
git remote get-url upstream 2>/dev/null || \
  git remote add upstream https://github.com/qwibitai/nanoclaw.git

git fetch upstream --quiet

# Archivos de src/ modificados respecto al upstream
DIFF_FILES=$(git diff upstream/main --name-only -- src/ container/ package.json 2>/dev/null)
```

**Evaluación:**
- Si `DIFF_FILES` está vacío → `log_ok "src/ idéntico al upstream"`
- Si hay archivos → `log_warn "Archivos modificados vs upstream:"` y listar cada uno con `git diff upstream/main -- <archivo> --stat`
- Inspecciona manualmente los diffs y anota si las modificaciones son las skills propias documentadas (add-github, add-google-calendar, etc.) o cambios inesperados

### 2.2 Búsqueda de código malicioso

```bash
# Dominios externos inesperados en el código
echo "--- Conexiones de red en src/ ---"
UNEXPECTED=$(grep -rn "fetch\|https://" src/ --include="*.ts" 2>/dev/null \
  | grep -v "api.telegram.org\|googleapis.com\|api.github.com\|anthropic\|ollama\|localhost\|127\.0\.0\|172\.17\.")
```

**Evaluación:**
- Si `UNEXPECTED` está vacío → `log_ok "No hay conexiones de red inesperadas en el código"`
- Si hay resultados → `log_fail "Conexiones externas no documentadas encontradas"` y mostrar cada línea para revisión manual

```bash
# Patrones de exfiltración
echo "--- Búsqueda de tokens hardcodeados ---"
HARDCODED=$(grep -rn \
  -e "sk-ant-" \
  -e "ghp_[A-Za-z0-9]" \
  -e "ya29\." \
  src/ --include="*.ts" 2>/dev/null)
```

**Evaluación:**
- Si vacío → `log_ok "No hay tokens hardcodeados en el código"`
- Si hay resultados → `log_fail "CRÍTICO: Token hardcodeado encontrado — rotar inmediatamente"` y detener la auditoría hasta que el usuario lo resuelva

### 2.3 Dependencias npm

```bash
echo "--- npm audit ---"
npm audit --audit-level=moderate 2>&1
NPM_EXIT=$?
```

**Evaluación:**
- `NPM_EXIT=0` → `log_ok "npm audit sin vulnerabilidades moderadas o superiores"`
- `NPM_EXIT=1` → `log_warn "npm audit encontró vulnerabilidades — revisar con: npm audit"`
- Si hay vulnerabilidades críticas o altas → `log_fail "Vulnerabilidades críticas/altas en dependencias"`

---

## Fase 3: Telegram — modo de conexión y whitelist

```bash
log_section "3. Auditoría de Telegram"
cd ~/nanoclaw
```

### 3.1 Verificar polling vs webhook

```bash
TELEGRAM_TOKEN=$(grep -E "^TELEGRAM" data/env/env 2>/dev/null | head -1 | cut -d= -f2)

if [ -z "$TELEGRAM_TOKEN" ]; then
  log_warn "No se encontró TELEGRAM_TOKEN en data/env/env — ¿está configurado Telegram?"
else
  WEBHOOK_INFO=$(curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo")
  WEBHOOK_URL=$(echo "$WEBHOOK_INFO" | jq -r '.result.url // ""')
fi
```

**Evaluación:**
- Si `WEBHOOK_URL` es vacío → `log_ok "Telegram en polling mode — no hay puerto expuesto"`
- Si `WEBHOOK_URL` no es vacío → `log_warn "Telegram en webhook mode — URL: $WEBHOOK_URL"` y ejecutar checks adicionales:

```bash
# Solo si hay webhook activo:
# 1. Verificar que el puerto HTTPS está en localhost, no expuesto
ss -tlnp | grep -E ":443|:8443|:80"

# 2. Buscar validación de firma de Telegram en el código
VALIDATES_SIG=$(grep -rn "secret_token\|X-Telegram-Bot-Api-Secret-Token\|validateWebhook" \
  src/ --include="*.ts" 2>/dev/null)
if [ -z "$VALIDATES_SIG" ]; then
  log_fail "Webhook activo sin validación de firma detectada en el código"
else
  log_ok "Webhook valida la firma de Telegram"
fi
```

### 3.2 Whitelist de chat_id en SQLite

```bash
echo "--- Grupos registrados ---"
sqlite3 store/messages.db "SELECT jid, name, channel, is_main FROM registered_groups;" 2>/dev/null
```

**Evaluación:**
- Mostrar la tabla completa al usuario
- `log_info "Verifica manualmente que reconoces todos los JIDs y nombres listados"`
- Si aparece `is_main=1` para más de una entrada → `log_warn "Más de un canal marcado como main — revisar"`

---

## Fase 4: Credenciales y secrets

```bash
log_section "4. Auditoría de credenciales"
cd ~/nanoclaw
```

### 4.1 Secrets en el historial de git

```bash
echo "--- Buscando secrets en historial de git ---"
GIT_SECRETS=$(git log --all -p 2>/dev/null \
  | grep -E "sk-ant-|ghp_[A-Za-z0-9]{36}|ya29\.|TELEGRAM.*=.*[0-9]{9}" \
  | head -5)
```

**Evaluación:**
- Si vacío → `log_ok "No se encontraron secrets en el historial de git"`
- Si hay resultados → `log_fail "CRÍTICO: Secret encontrado en historial de git — rotar el token y hacer git-filter-repo para limpiar el historial"`

### 4.2 data/env/env fuera de git

```bash
TRACKED=$(git ls-files data/env/ 2>/dev/null)
```

**Evaluación:**
- Si vacío → `log_ok "data/env/env no está trackeado por git"`
- Si no está vacío → `log_fail "CRÍTICO: data/env/env está en git — ejecutar: git rm --cached data/env/env && git commit"`

### 4.3 Permisos de archivos sensibles

```bash
ENV_PERMS=$(stat -c "%a" data/env/env 2>/dev/null)
DB_PERMS=$(stat -c "%a" store/messages.db 2>/dev/null)
```

**Evaluación y autocorrección (pedir confirmación antes):**
- Si `ENV_PERMS != 600` → `log_warn "data/env/env tiene permisos $ENV_PERMS, deberían ser 600"` y preguntar: "¿Corrijo los permisos con chmod 600 data/env/env? [s/n]"
- Si `DB_PERMS != 600` → mismo proceso para store/messages.db
- Si ambos son 600 → `log_ok "Permisos de archivos sensibles correctos (600)"`

### 4.4 .gitignore cubre archivos sensibles

```bash
GITIGNORE_OK=$(grep -E "data/env|\.env|store/" .gitignore 2>/dev/null | wc -l)
```

**Evaluación:**
- Si `GITIGNORE_OK >= 2` → `log_ok ".gitignore cubre data/env y store/"`
- Si no → `log_warn ".gitignore puede no cubrir todos los archivos sensibles — revisar manualmente"`

---

## Fase 5: Contenedores Docker

```bash
log_section "5. Auditoría de contenedores Docker"
```

### 5.1 Contenedores activos

```bash
echo "--- Contenedores activos ---"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null
```

### 5.2 Privilegios y capabilities

```bash
# Para cada contenedor de NanoClaw
for CID in $(docker ps -q 2>/dev/null); do
  NAME=$(docker inspect $CID --format '{{.Name}}' 2>/dev/null)
  PRIVILEGED=$(docker inspect $CID 2>/dev/null | jq -r '.[].HostConfig.Privileged')
  CAPS=$(docker inspect $CID 2>/dev/null | jq -r '.[].HostConfig.CapAdd | length')
  NET_MODE=$(docker inspect $CID 2>/dev/null | jq -r '.[].HostConfig.NetworkMode')

  echo "Contenedor: $NAME"

  if [ "$PRIVILEGED" = "false" ]; then
    log_ok "$NAME — no es privilegiado"
  else
    log_fail "$NAME — PRIVILEGED=true, aislamiento comprometido"
  fi

  if [ "$CAPS" = "0" ] || [ "$CAPS" = "null" ]; then
    log_ok "$NAME — sin capabilities adicionales"
  else
    log_warn "$NAME — tiene $CAPS capabilities adicionales — revisar"
  fi

  if [ "$NET_MODE" = "host" ]; then
    log_fail "$NAME — NetworkMode=host, sin aislamiento de red"
  else
    log_ok "$NAME — red aislada (mode: $NET_MODE)"
  fi
done
```

### 5.3 Proceso dentro del contenedor no es root

```bash
for CID in $(docker ps -q 2>/dev/null); do
  NAME=$(docker inspect $CID --format '{{.Name}}' 2>/dev/null)
  UID_IN_CONTAINER=$(docker exec $CID id -u 2>/dev/null)

  if [ "$UID_IN_CONTAINER" = "0" ]; then
    log_warn "$NAME — proceso corre como root (uid=0) dentro del contenedor"
  else
    log_ok "$NAME — proceso corre como uid=$UID_IN_CONTAINER (no-root)"
  fi
done
```

### 5.4 Mounts — verificar qué directorios expone cada contenedor

```bash
for CID in $(docker ps -q 2>/dev/null); do
  NAME=$(docker inspect $CID --format '{{.Name}}' 2>/dev/null)
  echo "Mounts de $NAME:"
  docker inspect $CID 2>/dev/null | jq -r '.[].Mounts[] | "\(.Source) → \(.Destination) [\(.Mode)]"'
done
```

**Evaluación manual:** Mostrar al usuario la lista completa de mounts y pedir que confirme que todos los paths del host son esperados. Alertar si aparece alguno de estos paths críticos:

```bash
DANGEROUS_MOUNTS=$(docker inspect $(docker ps -q) 2>/dev/null \
  | jq -r '.[].Mounts[].Source' \
  | grep -E "\.ssh|\.gnupg|\.aws|\.config/nanoclaw|/etc/|/root/" 2>/dev/null)

if [ -n "$DANGEROUS_MOUNTS" ]; then
  log_fail "Mounts peligrosos detectados: $DANGEROUS_MOUNTS"
else
  log_ok "No hay mounts en rutas sensibles del sistema"
fi
```

---

## Fase 6: Servidor Hetzner — red y SSH

```bash
log_section "6. Auditoría del servidor"
```

### 6.1 Puertos en escucha

```bash
echo "--- Puertos en escucha ---"
ss -tlnp
```

**Evaluación:**
- Mostrar output completo al usuario
- Buscar puertos inesperados:

```bash
UNEXPECTED_PORTS=$(ss -tlnp 2>/dev/null \
  | grep -v "127\.0\.0\.1\|::1\|:22 " \
  | grep -E "LISTEN" \
  | grep -v "^State")

if [ -z "$UNEXPECTED_PORTS" ]; then
  log_ok "Solo hay puertos internos o SSH expuestos"
else
  log_warn "Puertos potencialmente expuestos a internet:"
  echo "$UNEXPECTED_PORTS"
fi
```

### 6.2 Firewall UFW

```bash
UFW_STATUS=$(ufw status 2>/dev/null | head -1)
echo "UFW: $UFW_STATUS"

if echo "$UFW_STATUS" | grep -q "active"; then
  log_ok "UFW está activo"
  ufw status verbose
else
  log_warn "UFW no está activo — el único firewall activo es el de Hetzner Cloud"
fi
```

### 6.3 Hardening SSH

```bash
echo "--- Configuración SSH ---"
SSH_PASS=$(grep "^PasswordAuthentication" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
SSH_ROOT=$(grep "^PermitRootLogin" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
SSH_PUBKEY=$(grep "^PubkeyAuthentication" /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}')
```

**Evaluación y autocorrección:**
- `SSH_PASS=no` → `log_ok "PasswordAuthentication deshabilitado"`
- `SSH_PASS=yes` o vacío → `log_fail "PasswordAuthentication está habilitado — login con contraseña posible"` y preguntar si desea corregirlo
- `SSH_ROOT=no` → `log_ok "PermitRootLogin deshabilitado"`
- `SSH_ROOT=yes` o vacío → `log_warn "PermitRootLogin no está explícitamente deshabilitado"`
- `SSH_PUBKEY=yes` → `log_ok "PubkeyAuthentication habilitado"`

### 6.4 Usuarios del sistema con shell

```bash
echo "--- Usuarios con shell activo ---"
cat /etc/passwd | grep -v "nologin\|/bin/false" | cut -d: -f1,7
```

**Evaluación:** Mostrar al usuario y pedir confirmación de que todos son conocidos. Alertar si hay usuarios con nombres no reconocidos.

### 6.5 Actualizaciones de seguridad pendientes

```bash
echo "--- Paquetes con actualizaciones de seguridad ---"
apt list --upgradable 2>/dev/null | grep -i security | wc -l
PENDING=$(apt list --upgradable 2>/dev/null | grep -i security | wc -l)
```

**Evaluación:**
- `PENDING=0` → `log_ok "Sin actualizaciones de seguridad pendientes"`
- `PENDING>0` → `log_warn "$PENDING actualizaciones de seguridad pendientes"` y preguntar si desea ejecutar `sudo apt update && sudo apt upgrade -y`

---

## Fase 7: Integraciones OAuth

```bash
log_section "7. Auditoría de integraciones OAuth"
cd ~/nanoclaw
```

### 7.1 Google Calendar — scopes del token

```bash
TOKEN_FILE=$(find . ~/.config -name "token*.json" 2>/dev/null | grep -i calendar | head -1)

if [ -z "$TOKEN_FILE" ]; then
  log_info "No se encontró token de Google Calendar almacenado localmente"
else
  SCOPES=$(cat "$TOKEN_FILE" 2>/dev/null | jq -r '.scope // ""')
  echo "Google Calendar scopes activos: $SCOPES"

  if echo "$SCOPES" | grep -q "calendar.readonly"; then
    log_ok "Google Calendar usa scope readonly"
  elif echo "$SCOPES" | grep -q "calendar"; then
    log_warn "Google Calendar tiene scope de escritura — ¿es necesario?"
  fi

  if echo "$SCOPES" | grep -q "https://www.googleapis.com/auth/$" || \
     echo "$SCOPES" | grep -q "https://mail.google.com"; then
    log_fail "Scope de Google excesivamente amplio — reducir"
  fi
fi
```

### 7.2 GitHub PAT — tipo y permisos

```bash
GITHUB_TOKEN=$(grep "^GITHUB_TOKEN" data/env/env 2>/dev/null | cut -d= -f2)

if [ -z "$GITHUB_TOKEN" ]; then
  log_info "No se encontró GITHUB_TOKEN en data/env/env"
else
  # Verificar tipo de token (fine-grained vs classic)
  if echo "$GITHUB_TOKEN" | grep -q "^github_pat_"; then
    log_ok "GitHub PAT es fine-grained (github_pat_...)"
  elif echo "$GITHUB_TOKEN" | grep -q "^ghp_"; then
    log_warn "GitHub PAT es classic (ghp_...) — migrar a fine-grained PAT para permisos mínimos"
  fi

  # Verificar scopes (no muestra el token)
  SCOPES_HEADER=$(curl -s -I \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    https://api.github.com/rate_limit 2>/dev/null \
    | grep -i "x-oauth-scopes")
  echo "GitHub PAT scopes: $SCOPES_HEADER"

  if echo "$SCOPES_HEADER" | grep -qE "delete_repo|admin|write:org"; then
    log_fail "GitHub PAT tiene scopes muy amplios — reducir a mínimos necesarios"
  else
    log_ok "GitHub PAT scopes parecen razonables — verificar manualmente"
  fi
fi
```

---

## Fase 8: Mount allowlist

```bash
log_section "8. Auditoría de mount allowlist"

ALLOWLIST_FILE="$HOME/.config/nanoclaw/mount-allowlist.json"

if [ ! -f "$ALLOWLIST_FILE" ]; then
  log_warn "No se encontró mount-allowlist.json en ~/.config/nanoclaw/"
else
  echo "--- Mount allowlist actual ---"
  cat "$ALLOWLIST_FILE"

  # Buscar paths peligrosos en el allowlist
  DANGEROUS=$(cat "$ALLOWLIST_FILE" | grep -E "\.ssh|\.gnupg|\.aws|\.config/nanoclaw|/etc/" 2>/dev/null)

  if [ -n "$DANGEROUS" ]; then
    log_fail "Paths sensibles en mount allowlist: $DANGEROUS"
  else
    log_ok "Mount allowlist no expone rutas sensibles del sistema"
  fi

  # Verificar permisos del propio allowlist
  ALLOWLIST_PERMS=$(stat -c "%a" "$ALLOWLIST_FILE" 2>/dev/null)
  if [ "$ALLOWLIST_PERMS" = "600" ] || [ "$ALLOWLIST_PERMS" = "644" ]; then
    log_ok "Permisos del allowlist: $ALLOWLIST_PERMS"
  else
    log_warn "Permisos del allowlist: $ALLOWLIST_PERMS — revisar"
  fi
fi
```

---

## Fase 9: Base de datos SQLite

```bash
log_section "9. Auditoría de SQLite"
cd ~/nanoclaw
```

```bash
# Tablas existentes
echo "--- Tablas en messages.db ---"
sqlite3 store/messages.db ".tables" 2>/dev/null

# Grupos registrados — el más crítico
echo "--- Grupos registrados ---"
sqlite3 store/messages.db \
  "SELECT jid, name, channel, is_main FROM registered_groups;" 2>/dev/null

# Cuántos mensajes almacenados
MSG_COUNT=$(sqlite3 store/messages.db "SELECT COUNT(*) FROM messages;" 2>/dev/null)
log_info "$MSG_COUNT mensajes almacenados en SQLite (texto plano)"

# Tareas programadas activas
echo "--- Tareas programadas activas ---"
sqlite3 store/messages.db \
  "SELECT id, schedule_type, schedule_value, status, next_run FROM scheduled_tasks WHERE status='active';" 2>/dev/null
```

**Evaluación:**
- Mostrar grupos registrados y pedir al usuario que confirme que los reconoce todos
- Si `MSG_COUNT > 10000` → `log_warn "Alto volumen de mensajes almacenados en texto plano — considera purgar mensajes antiguos"`
- Verificar permisos: si no son 600 → proponer corrección

---

## Fase 10: Generación del informe final

```bash
log_section "Resumen ejecutivo"
```

Cuenta los hallazgos por categoría:

```bash
OK_COUNT=$(grep -c "✅ OK" ~/audit-report.md 2>/dev/null || echo 0)
WARN_COUNT=$(grep -c "⚠️  WARN" ~/audit-report.md 2>/dev/null || echo 0)
FAIL_COUNT=$(grep -c "❌ FAIL" ~/audit-report.md 2>/dev/null || echo 0)

echo "" >> ~/audit-report.md
echo "## Resumen ejecutivo" >> ~/audit-report.md
echo "| Resultado | Count |" >> ~/audit-report.md
echo "|---|---|" >> ~/audit-report.md
echo "| ✅ OK | $OK_COUNT |" >> ~/audit-report.md
echo "| ⚠️ WARN | $WARN_COUNT |" >> ~/audit-report.md
echo "| ❌ FAIL | $FAIL_COUNT |" >> ~/audit-report.md
echo "" >> ~/audit-report.md
echo "_Informe completo guardado en ~/audit-report.md_" >> ~/audit-report.md
```

Muestra el resumen final al usuario y la ruta del informe:

```bash
echo ""
echo "============================================"
echo "AUDITORÍA COMPLETA"
echo "✅ OK:   $OK_COUNT"
echo "⚠️  WARN: $WARN_COUNT"
echo "❌ FAIL: $FAIL_COUNT"
echo ""
echo "Informe guardado en: ~/audit-report.md"
echo "============================================"
```

Si `FAIL_COUNT > 0`, lista todos los FAILs con sus correcciones recomendadas y pregunta al usuario cuáles desea aplicar ahora.

Si `FAIL_COUNT = 0` y `WARN_COUNT = 0`, felicita al usuario: el sistema está en buen estado de seguridad.

---

## Notas de implementación

- **Solo lectura por defecto.** Todos los comandos de este skill son no-destructivos salvo los de corrección de permisos (`chmod`) y actualización de paquetes (`apt upgrade`), los cuales siempre requieren confirmación explícita del usuario.
- **No modifica código fuente.** Si la auditoría detecta un problema estructural (ej. token hardcodeado en código), reporta y para — no intenta corregirlo automáticamente.
- **Requiere sqlite3.** Si no está instalado: `sudo apt install -y sqlite3`
- **Requiere jq.** Si no está instalado: `sudo apt install -y jq`
- **Dependencia blanda de hcloud CLI.** Si está disponible, puede verificar las reglas del firewall Hetzner cloud directamente. Si no, indicar al usuario que lo verifique manualmente en https://console.hetzner.cloud.
