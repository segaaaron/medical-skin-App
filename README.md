# MedSkin · backend

API de MedSkin, la plataforma de medicina estética. Dos apps la consumen: la de la doctora y la
de la paciente.

## Empezar

```bash
docker compose up -d          # PostgreSQL 17, Redis 7.4 y MinIO
pnpm install
cp .env.example .env
pnpm db:migrate               # esquema y políticas RLS
pnpm start:dev                # http://localhost:3000
```

Puertos **5433** (Postgres), **6380** (Redis) y **9000/9001** (MinIO), a propósito: dejan libres
los de los servicios que ya estén instalados en la máquina.

## Qué se usa y por qué

**[`docs/diseno/tecnologia.md`](docs/diseno/tecnologia.md)** — la pila con sus versiones, lo que
se descartó y por qué, qué hay ya instalado en esta máquina y qué falta. Empieza por ahí.

## Los documentos, por orden

| Documento | Para qué |
|---|---|
| [`docs/diseno/tecnologia.md`](docs/diseno/tecnologia.md) | La pila, las versiones y cómo se levanta todo |
| [`docs/diseno/medskin-design.md`](docs/diseno/medskin-design.md) | Arquitectura, modelo de datos, pipeline de imágenes, notificaciones, seguridad |
| [`docs/diseno/medskin-estado.md`](docs/diseno/medskin-estado.md) | Las decisiones de producto que el backend tiene que respetar, y por qué se tomaron |
| [`docs/contratos/`](docs/contratos/) | Un archivo por recurso. **Ningún servicio se construye sin su contrato escrito antes** |

El diseño de las apps está en el lienzo: (enlace privado, en local)
(62 tableros, 199 pantallas). Cada pantalla lleva debajo la explicación de por qué está así: eso
es requisito, no comentario.

## Las dos reglas que no se rompen

**RLS forzada.** Toda tabla con datos de una consulta lleva `tenant_id` y política
`FORCE ROW LEVEL SECURITY`. Cada petición fija `SET LOCAL app.tenant_id` en su transacción. La
conexión de la aplicación no es dueña de las tablas ni superusuario: si lo fuera, RLS no se le
aplicaría. Por eso hay dos usuarios de base de datos, y el de la API está marcado `NOBYPASSRLS`.

Antes de cerrar cualquier recurso nuevo: una prueba que intente leer datos de otro inquilino y
compruebe que devuelve vacío.

**Nada clínico sale de la app.** Ni en una notificación, ni en el asunto de un correo, ni en una
URL, ni en un mensaje de error, ni por WhatsApp.

## Cómo se trabaja aquí

| Agente | Para qué |
|---|---|
| `po-backend` | Escribe los contratos: forma, **todos los errores con la frase que ve el usuario**, quién puede llamar, idempotencia |
| `backend-senior` | Implementa: migración con su RLS, dominio sin framework, caso de uso, repositorio, controlador |

Y la skill **`owasp`**: el Top 10 como lista de preguntas a contestar con archivo y línea. Se
recorre entera antes de dar por terminado cualquier servicio que toque datos, acceso o permisos.

**Tests: solo lógica y servicios.** Nada de interfaz, nada de comprobar que un doble fue llamado.
Cuando cambies algo, ejecuta solo el test que tocaste.
