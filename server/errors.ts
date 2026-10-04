/** Erreur destinee a etre renvoyee telle quelle a l'appelant (code HTTP inclus). */
export class PsimError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
