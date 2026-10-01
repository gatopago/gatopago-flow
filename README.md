# Flow

Backend comercial independiente: merchants, links, PaymentIntents, quotes, attempts, liquidación, conciliación y webhooks. El checkout externo funciona sin llamar a Wallet Core y los datos viven únicamente en `PAYMENTS_DB`.

Las peticiones con sesión Consumer se autentican mediante el service binding privado
`WALLET_IDENTITY`, dirigido al entrypoint `WalletIdentity` del Wallet Core del mismo
entorno. Wallet Core verifica el ID token custom de Firebase y la credencial vigente
en su base; Flow recibe sólo `user_id`, entorno y vencimiento. No almacena ni cachea
esa autorización, no verifica Firebase por separado y no accede a la base de Wallet
Core. Un token inválido produce 401; un fallo del servicio produce 503, incluso en
checkout con sesión opcional. No se convierte ese fallo en una compra anónima.
Checkout sin sesión y API keys comerciales conservan su funcionamiento independiente.

Las rutas públicas del runtime actual son:

| Ruta | Autenticación |
| --- | --- |
| `/checkout/v1/:linkId` y sus operaciones | Lectura pública; prueba del pagador y capability para intentos |
| `/v1/payment_links` | Sesión para crear/listar; lectura individual pública |
| `/v1/merchant/*` | Sesión del propietario |
| `/v1/payment_intents/*`, `/v1/events/*` | API key comercial |
| `/v1/health`, `/v1/health/live` | Estado público; `/v1/health/ops` exige el token operativo |

No se mantienen aliases `/checkout/*`, `/links/*` ni `/merchant/*`.

`GATOPAGO_ENVIRONMENT` debe coincidir en ambos Workers. El binding local de Wrangler
es un candidato: antes de desplegar hay que apuntarlo al Worker provisionado del
entorno. La revocación local se comprueba en cada petición. Wallet Core reconcilia ADMIN
onchain mediante dos RPC y reutiliza evidencia como máximo 30 segundos, limitada
también por su vigencia de finalidad. La detección incluye la finalidad de la red;
readmitir una llave no restaura sus sesiones anteriores.

- `http.ts` compone middleware, health y rutas. `index.ts` conecta HTTP, RPC, Queue y Cron.
- `commands.ts` implementa los comandos actuales de Wallet Core; no convierte formatos anteriores.
- `domain` contiene modelos, validación y presentación pública, sin SQL.
- `repositories` separa cuentas de liquidación, intents/links, quotes, attempts, crosschain, fees y settlement.
- `stores` concentra la persistencia operativa: colas, leases, journal y límites.
- `rails/onchain` contiene el acceso a Circle; `services` compone cotización, ejecución y conciliación.
- `maintenance.ts` coordina el barrido periódico y la rotación de secretos de webhook.

Settlement conserva en un mismo batch el pago, ledger, eventos y outbox. Dividir responsabilidades no divide esa transacción. Las lecturas HTTP de proveedores se cancelan al exceder 64 KiB.

Se acepta RPC versión 3 con `claim.userId` (ID interno canónico), sin `uid` ni
conversión de versiones anteriores. La persistencia usa `owner_user_id` y
`payer_user_id`, sin referencias al proveedor de sesión. El formato de cola sigue
en su revisión 2: su payload no cambió y no representa Account V2. Los comandos identifican `gatopago-wallet-core`; el número de revisión de una cuenta de liquidación no es la generación del contrato Account. Los endpoints de checkout para leer/registrar intentos están ligados al link; los aliases y el endpoint comercial `/onchain` anteriores no existen.

`migrations/0001_initial.sql` crea una base nueva completa. Flow no exige un checksum ni una tabla de importación de Parmelia. Los controles de signer, rutas, tarifas, cuotas e integridad siguen vigentes.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm verify
```

Los comandos anteriores se ejecutan desde esta carpeta. Las ABIs se consumen
mediante un snapshot de `@gatopago/shared/payment-abis` fijado en `vendor/`;
construir o probar Flow no necesita Foundry ni el checkout de contratos. El
productor verifica las ABIs antes de promover una nueva versión; el consumidor
no las regenera. `check:query-plans` comprueba únicamente las migraciones propias.

`wrangler.jsonc` es el perfil local. `deploy` utiliza `wrangler.remote.jsonc`
para actualizar el Worker existente `gatopago-flow` (antes
`gatopago-payments-api`) en `api.gatopago.com/v1/*` y `/checkout/v1/*`.
El perfil remoto apunta a la base limpia V3, las colas V3 y el entrypoint
`WalletIdentity` de `gatopago-wallet-core`. No importa datos de la base anterior.
Los secretos se suministran según `.dev.vars.example`; el deploy conserva los
ya cargados en el Worker. `deploy:dry-run` comprueba la compilación sin publicar.
Desde esta carpeta: `pnpm deploy:dry-run`, o
`pnpm deploy:dry-run --staging` para inspeccionar staging sin publicar.
Publicar requiere una autorización aparte y el árbol de este proyecto limpio.

El modelo comercial actual mantiene un owner por merchant. Organization/Membership/Project/Customer son trabajo de producto futuro, no capas vacías añadidas a esta renovación.
