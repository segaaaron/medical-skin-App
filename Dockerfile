# MedSkin · imagen de producción
#
# Tres etapas y un solo objetivo: que lo que llegue al servidor sea `dist/` y las dependencias
# de producción, y nada más. Ni el código fuente, ni las pruebas, ni `devDependencies`.
#
# Node 22 porque `package.json` lo exige (`>=22 <23`) y porque `node --env-file` —que es como
# arranca la aplicación— no existe antes. Debian y no Alpine: `sharp` y `argon2` traen binarios
# compilados contra glibc, y en musl o se recompilan o fallan al cargar.

# ---------------------------------------------------------------------------- dependencias
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
# `pnpm-workspace.yaml` VIAJA CON LOS OTROS DOS, y no es opcional: pnpm 11 lee desde ahí los
# `overrides` —`fastify` 5.12.7 y `esbuild` 0.27.2, que son dos avisos de `pnpm audit` cerrados— y
# la lista `onlyBuiltDependencies`. Sin él, dentro de la imagen pnpm no ve ningún `override`, el
# candado sí los tiene, y la instalación muere con `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. Y si no
# muriera sería peor: sin `onlyBuiltDependencies` no corre el script de instalación de `sharp`, y
# `require('sharp')` revienta al arrancar el trabajador de imágenes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `--frozen-lockfile`: si el candado no cuadra con el `package.json`, la construcción FALLA en vez
# de resolver otra versión por su cuenta. Un despliegue no es el sitio donde descubrir una subida
# de versión.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------- construcción
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------- lo que corre
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
# Las migraciones son archivos `.sql` y viajan aparte: `dist/` no las lleva porque `tsc` solo
# compila TypeScript. Y van a `src/shared/db/migrations` y no a otro sitio porque el migrador
# nombra esa ruta RELATIVA a la carpeta de trabajo (`migrate.ts:13`).
COPY src/shared/db/migrations ./src/shared/db/migrations

# No corre como `root`: la imagen de Node ya trae el usuario `node`.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# LAS MIGRACIONES ANTES DE ESCUCHAR, y en el mismo contenedor: si fallan, el proceso muere y el
# despliegue no se da por bueno. Un arranque que sirve peticiones contra un esquema viejo es peor
# que uno que no arranca.
#
# Sin `--env-file`: en el servidor las variables vienen del entorno, no de un archivo.
CMD ["sh", "-c", "node dist/shared/db/migrate.js && node dist/main.js"]
