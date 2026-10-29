// POST /v1/patients · solo HTTP. La autorización la hizo el guardia por lista blanca de
// rutas, el permiso lo mira el caso de uso y el inquilino lo ponen las políticas.
//
// LA IDEMPOTENCIA YA NO VIVE AQUÍ, y el cambio es el arreglo de tres defectos que el revisor
// bloqueó el 28 de octubre:
//
//   1. la respuesta de este endpoint lleva la contraseña temporal EN CLARO cuando la vía es
//      `whatsapp` o `ninguna`, y guardarla en Redis dejaba 24 h una credencial viva, el
//      nombre y el correo de una paciente fuera de la base, sin cifrar y sin HMAC;
//   2. la fila se escribía DESPUÉS del `COMMIT` y en otro almacén, así que un parpadeo de
//      Redis devolvía un `500` cuya frase era falsa —la ficha ya existía— y el reintento
//      creaba una SEGUNDA ficha sobre la misma cuenta, por la salida que el contrato ofrece
//      ante el duplicado («Es otra persona»);
//   3. sin la cabecera, el mecanismo entero se apagaba en silencio.
//
// Ahora la clave se lee aquí —porque es una cabecera: transporte— y se **comprueba y se
// reserva dentro de la transacción que crea la ficha**, en `idempotency_key`. La cabecera es
// obligatoria: sin ella, `400 clave_idempotencia_faltante`, y no se ejecuta nada.
//
// La repetición devuelve la respuesta completa, contraseña incluida, que es la decisión
// escrita del 27 de octubre: «una sola vez» significa que ninguna LECTURA posterior la trae,
// no que el reintento de la misma petición se quede sin ella. Y deja su propia línea en la
// bitácora, que la escribe la misma transacción que la leyó.
//
// Este controlador vive en `modules/accounts` a propósito: `cuentas.md` contrata este
// endpoint. La ficha de `pacientes.md` —la lista, la búsqueda, la edición— es el tramo 2.

import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';

import type { RequestWithContext } from '../../shared/http/request-context';
import { readIdempotencyKey } from '../../shared/idempotency/idempotency-key';
import { callerOf } from './accounts.controller';
import { RegisterPatient } from './application/register-patient';

@Controller('v1/patients')
export class PatientsController {
  // `@Inject` explícito: esbuild no emite `emitDecoratorMetadata`.
  constructor(@Inject(RegisterPatient) private readonly register: RegisterPatient) {}

  @Post()
  @HttpCode(201)
  async create(@Req() req: RequestWithContext): Promise<unknown> {
    const body: unknown = req.body;
    return this.register.run(body, callerOf(req), readIdempotencyKey(req, body));
  }
}
