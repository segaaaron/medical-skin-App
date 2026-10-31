// PUT /v1/links/{id}/medical-form · «Antes de atenderte». La paciente llena sus propios
// antecedentes. Es el `siguiente_paso: "ficha_medica"` de `acceso.md`.
//
// LA REGLA, Y ES LO ÚNICO QUE ESTE CONTRATO INVENTA: la paciente escribe un campo **solo si
// está vacío o si lo escribió ella**. Un campo que escribió la doctora no se sobrescribe, y la
// respuesta dice cuáles no se guardaron y por qué. Guardar por encima sería perder una
// anotación clínica sin que nadie se entere; callarlo sería mentirle sobre su propio
// expediente.
//
// SIN `fototipo` Y SIN `notas`: el fototipo lo evalúa quien la ve y `notas` es el cuaderno de la
// doctora. No es una promesa de este archivo: `app_patient` no tiene `GRANT` sobre esas dos
// columnas, así que un intento muere con «permiso denegado» (0006).

import { ContractError } from '../../../shared/contract/error-catalog';
import type { Caller } from '../../access/application/caller';
import { readHistory } from '../../accounts/domain/patient-registration';
import type { PatientHistoryWritePort } from '../domain/ports';
import { patientOf } from './patient-links';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export type HistoryWriteResponse = {
  guardado: readonly string[];
  no_guardado: readonly { campo: string; por_que: string }[];
  siguiente_paso: string;
};

export class WritePatientHistory {
  constructor(private readonly history: PatientHistoryWritePort) {}

  async run(linkId: string, input: unknown, caller: Caller): Promise<HistoryWriteResponse> {
    const account = patientOf(caller);
    if (!UUID.test(linkId)) throw new ContractError('vinculo_no_existe');

    // Las MISMAS validaciones del paso 3 del alta: los cuatro errores de forma son los suyos.
    const draft = readHistory(input);

    const result = await this.history.write(account, linkId, draft);
    if (result.outcome === 'no_link') throw new ContractError('vinculo_no_existe');
    // Todavía no aceptó a esa doctora: la app navega a «¿Es esta tu doctora?». Y no es solo
    // una comprobación de este código: la política de `medical_history` para `app_patient`
    // exige `status = 'vinculada'`, así que sin aceptar no hay fila que escribir.
    if (result.outcome === 'not_accepted') throw new ContractError('vinculo_sin_aceptar');

    return {
      guardado: result.saved,
      no_guardado: result.skipped.map((campo) => ({
        campo,
        por_que: 'lo_escribio_tu_doctora',
      })),
      // «La ficha médica no bloquea la app»: sigue siendo `ficha_medica` hasta que llene algo,
      // y `Vinculacion` · 2 tiene «Lo hago después».
      siguiente_paso: result.saved.length > 0 ? 'inicio' : 'ficha_medica',
    };
  }
}
