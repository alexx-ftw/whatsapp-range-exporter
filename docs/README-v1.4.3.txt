WHATSAPP RANGE EXPORTER v1.4.3
Publicación pública con actualización automática

INSTALAR UNA VEZ
Abre https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js
con Tampermonkey o Violentmonkey y confirma la instalación o actualización.
Como alternativa, sustituye el código del script existente por el TXT completo.
Guarda y recarga WhatsApp Web. Activa las actualizaciones en el gestor.
Las versiones anteriores sin metadatos de actualización requieren este paso inicial.

ACTUALIZACIÓN
@updateURL y @downloadURL usan el archivo estable de main, accesible sin cuenta.
No contienen tokens, contraseñas ni URLs temporales. Las nuevas versiones deben
actualizar ese archivo e incrementar @version y VERSION. La frecuencia de
comprobación depende del gestor. Un tag o ZIP por sí solo no cambia main.

COMPATIBILIDAD
El userscript de esta publicación coincide byte por byte con el TXT 1.4.3
preparado anteriormente. Se conservan @name, @namespace, @grant, @match,
@require y todo el cuerpo de ejecución de 1.4.2 salvo VERSION.
No se reescribe el exportador ni se introduce un actualizador propio.
La documentación de esta publicación sustituye los avisos anteriores de
repositorio privado y versión pendiente de subir.

ARCHIVOS
WhatsApp-Range-Exporter.user.js: script instalable.
WhatsApp-Range-Exporter-v1.4.3.txt: copia idéntica como texto.
SHA256SUMS.txt: sumas de comprobación del paquete.

PRIVACIDAD Y LÍMITES
Se publica código y documentación; no se distribuyen conversaciones exportadas,
adjuntos de chats, capturas privadas ni muestras reales de DOM.
Los límites de exportación y portapapeles siguen siendo los de 1.4.2.
La comprobación de publicación no equivale a probar una actualización automática
real en el gestor del usuario ni a probar una sesión real de WhatsApp.

FUENTES
https://www.tampermonkey.net/documentation.php#meta:updateURL
https://www.tampermonkey.net/documentation.php#meta:downloadURL
https://violentmonkey.github.io/api/metadata-block/
