// Thème choisi (Jour / Nuit), posé AVANT le premier affichage : pas d'éclair blanc sur un écran réglé en Nuit.
// Script classique (pas un module) chargé dans <head> : il s'exécute tout de suite. Sans choix mémorisé, le thème suit
// le système (« Automatique »). Le stockage peut être indisponible (navigation privée, réglages) : rien ne casse.
(function () {
  try {
    var theme = window.localStorage.getItem('portal.theme');
    if (theme === 'day' || theme === 'night') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* stockage indisponible : thème du système */
  }
})();
