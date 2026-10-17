import express from 'express';
import type { Express, Request, RequestHandler } from 'express';
import { PsimError } from './engine.ts';
import type { AccessService, ControllerInput, DoorInput, SearchFilters } from './access.ts';

/**
 * Routes `/api/access/*` du controle d'acces (contrat : docs/ACCES.md § 3). Aucune regle metier ici : le service
 * (`server/access.ts`) valide TOUT (corps, filtres, identifiants) et leve des `PsimError` que le gestionnaire d'erreurs
 * d'`api.ts` traduit. Ce module ne fait que : garde de role, lecture du corps (10 ko), choix du code HTTP, envoi du CSV.
 *
 * Roles : consulter (portes, fiche, passages, export, reglages) = tout utilisateur connecte ; declarer les controleurs et les
 * portes et regler la conservation = administrateur. Les identifiants des controleurs sont en ecriture seule : le service ne
 * les expose jamais, aucune route ne les renvoie.
 */
export interface AccessApi {
  /** Monte les routes. A appeler AVANT la route « /api » de repli (404) d'api.ts. */
  mount(app: Express, guards: { anyUser: RequestHandler; adminOnly: RequestHandler; actorOf: (req: Request) => string }): void;
}

/** Motif d'identifiant (controleur, detecteur) : meme que le service ; autre chose ne peut rien designer, donc 404 sans interroger la base. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const two = (n: number) => String(n).padStart(2, '0');

/** `AAAA-MM-JJ` (heure locale du serveur, comme les autres exports). */
function dayStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Identifiant d'URL valide, ou 404 (message propre a la ressource). */
function idOf(req: Request, what: string): string {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new PsimError(404, `${what} introuvable`);
  return raw;
}

export function createAccessApi(access: AccessService, options: { now?: () => number } = {}): AccessApi {
  const now = options.now ?? Date.now;

  function mount(app: Express, guards: { anyUser: RequestHandler; adminOnly: RequestHandler; actorOf: (req: Request) => string }): void {
    // Noms lus tels quels par l'auto-test des routes (test/e2e-attack.test.ts) : chaque route porte `anyUser` ou `adminOnly`.
    const { anyUser, adminOnly, actorOf } = guards;
    const json = express.json({ limit: '10kb' });
    const bodyOf = (req: Request): unknown => req.body ?? {};

    // ---- Controleurs (administrateur : meme la liste, elle dit ou et comment le PSIM joint les appareils) ----
    app.get('/api/access/controllers', adminOnly, (_req, res) => {
      res.json(access.controllers());
    });
    app.post('/api/access/controllers', adminOnly, json, (req, res) => {
      res.status(201).json(access.createController(actorOf(req), bodyOf(req) as ControllerInput));
    });
    app.put('/api/access/controllers/:id', adminOnly, json, (req, res) => {
      res.json(access.updateController(actorOf(req), idOf(req, 'Controleur'), bodyOf(req) as ControllerInput));
    });
    app.delete('/api/access/controllers/:id', adminOnly, (req, res) => {
      access.deleteController(actorOf(req), idOf(req, 'Controleur'));
      res.status(204).end();
    });

    // ---- Portes ----
    app.get('/api/access/doors', anyUser, (_req, res) => {
      res.json(access.doors());
    });
    app.get('/api/access/doors/:id', anyUser, (req, res) => {
      res.json(access.door(idOf(req, 'Porte')));
    });
    app.post('/api/access/doors', adminOnly, json, (req, res) => {
      res.status(201).json(access.declareDoor(actorOf(req), bodyOf(req) as DoorInput));
    });
    app.put('/api/access/doors/:id', adminOnly, json, (req, res) => {
      res.json(access.updateDoor(actorOf(req), idOf(req, 'Porte'), bodyOf(req) as DoorInput));
    });
    app.delete('/api/access/doors/:id', adminOnly, (req, res) => {
      access.removeDoor(actorOf(req), idOf(req, 'Porte'));
      res.status(204).end();
    });

    // ---- Journal des passages : la requete est transmise telle quelle (le service valide et journalise l'auteur) ----
    app.get('/api/access/events', anyUser, (req, res) => {
      res.json(access.search(req.query as SearchFilters, actorOf(req)));
    });
    app.get('/api/access/events.csv', anyUser, (req, res) => {
      const result = access.exportCsv(req.query as SearchFilters, actorOf(req));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="passages_${dayStamp(now())}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Export-Rows', String(result.rows));
      if (result.truncated) res.setHeader('X-Export-Truncated', '1');
      res.send(result.csv);
    });

    // ---- Conservation ----
    app.get('/api/access/settings', anyUser, (_req, res) => {
      res.json(access.settings());
    });
    app.put('/api/access/settings', adminOnly, json, (req, res) => {
      const body = bodyOf(req);
      const days = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { retentionDays?: unknown }).retentionDays : undefined;
      res.json(access.setRetention(actorOf(req), days));
    });
  }

  return { mount };
}
