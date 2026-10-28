// `DELETE /v1/cuentas/mia` · lo que el borrado promete por escrito, sin NestJS y sin `pg`.
//
// DOS COSAS QUE PARECEN LA MISMA Y NO LO SON: el PLAZO sale de la configuración del
// despliegue (`CONSERVACION_ANOS`), y la FECHA que se le promete a quien se borra se guarda
// como hecho histórico de ese borrado. Si mañana el plazo de la región pasa de siete años a
// diez, no cambia lo que se le prometió a quien ya se fue (`cuentas.md`, 28 de octubre).

/**
 * `se_borro` ENUMERA LO QUE EL BORRADO CUBRE, NO LO QUE ENCONTRÓ. `fotos_que_subiste` y
 * `tokens_de_aviso` son tablas de los tramos 6 y 7 y todavía no existen, así que hoy el
 * borrado las cubre con cero filas y la lista no miente. **No se quitan:** el día que esas
 * tablas existan se borran dentro de la misma función, no en otro sitio, y la promesa que
 * la pantalla ya hace tiene que seguir siendo la misma.
 */
export const DELETED_ITEMS = [
  'acceso',
  'fotos_que_subiste',
  'datos_de_contacto',
  'sesiones',
  'tokens_de_aviso',
] as const;

/** `se_conserva`, literal del contrato. Lo único variable es `hasta`. */
export const RETAINED_RECORD = {
  que: 'expediente_clinico',
  por_que: 'Tu doctora tiene que conservar tu historia clínica por ley.',
  vuelve_si: 'Tu doctora te da de alta otra vez con este mismo correo.',
} as const;

/**
 * `se_conserva.hasta`: la fecha del borrado más el plazo de la región, en `AAAA-MM-DD`.
 *
 * Se calcula sobre la fecha UTC del instante y no sobre la zona del despliegue: es una cota
 * a siete años, donde un día de diferencia no significa nada, y así la misma entrada
 * produce la misma salida en cualquier máquina —incluida la de las pruebas—.
 */
export function retentionUntil(deletedAt: Date, years: number): string {
  const until = new Date(
    Date.UTC(deletedAt.getUTCFullYear() + years, deletedAt.getUTCMonth(), deletedAt.getUTCDate()),
  );
  return until.toISOString().slice(0, 10);
}

/**
 * «14 de noviembre», para la frase del `409 suscripcion_activa`. El día llega como
 * `AAAA-MM-DD` desde `plan_renews_on`, que es una columna `date`: se lee y se formatea como
 * texto, sin pasar por la zona del proceso, porque convertirlo a un instante lo movería un
 * día entero en cualquier zona al este de Greenwich.
 */
export function dayAndMonth(day: string): string {
  const formatter = new Intl.DateTimeFormat('es-BO', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  });
  return formatter.format(new Date(`${day}T00:00:00Z`));
}

/**
 * «148 pacientes» · «1 paciente». El contrato escribe el caso plural y concordar el
 * singular es interpolar bien, no cambiar la frase: es la misma regla que el «te quedan 1
 * intentos» de `POST /v1/acceso`.
 */
export function patientsPhrase(count: number): string {
  return count === 1 ? '1 paciente' : `${count} pacientes`;
}
