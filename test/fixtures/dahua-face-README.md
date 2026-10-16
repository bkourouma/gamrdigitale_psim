# Jeux d'essai `dahua-face-*`

Construits d'apres la documentation Dahua et des exemples publies ; **a confirmer sur le vrai XVR (lot V4)**.
Aucune vraie photo, aucune vraie personne : les noms sont fictifs.

- `dahua-face-recognition-known.txt`, `-unknown.txt`, `-two-candidates.txt` : parties « Code=FaceRecognition;action=...;index=...;data={...} ».
  Modele : exemple reel d'un NVR DHI-NVR2116HS-I/L, https://github.com/rroller/dahua/issues/573 (Candidates[] { Similarity, Person { UID, PersonID,
  GroupID, Name, GroupName, ... } } a la racine, repete dans `Face` et `Object`). Les champs d'images et de numero de piece sont volontairement raccourcis ou fictifs.
- `dahua-face-detection.txt` : partie « Code=FaceDetection;... ». Contenu **non confirme** par la documentation consultee (seul le code est documente).
- `dahua-face-groups.txt` : reponse de `/cgi-bin/faceRecognitionServer.cgi?action=findGroup`, au format « GroupList[N].champ=valeur » du client
  https://github.com/brainofcoco/itips-v2-ai (qui cite la Dahua HTTP API V3.98). Casse des noms et champs **non confirmes**.
- `dahua-face-groups-empty.txt` : reponse vide (« 200, vide » = aucune base), celle du vrai XVR a ce jour.
- `dahua-face-hostile.txt` : donnees piegees (`__proto__`, controles, nom tres long, similarites absurdes, photo base64).

Chaque fichier `.txt` est le texte brut tel que l'appareil l'enverrait ; les essais normalisent les fins de ligne a la lecture (extraction CRLF sous Windows).
