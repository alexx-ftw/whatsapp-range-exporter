WHATSAPP RANGE EXPORTER v1.5.2
Acceso compacto en el margen derecho, encima del control de WhatsApp

CAMBIO
El desplazamiento horizontal de 1.5.1 evitaba el botón nativo, pero podía tapar
mensajes. El acceso vuelve al margen derecho y se separa verticalmente:
- 20 px desde el borde derecho, más el área segura del dispositivo.
- 164 px desde abajo, más el área segura inferior.
- Tamaño de 44 x 44 px, frente a los 52 x 52 px anteriores.
- Mismo icono, temas, nombre accesible y atajo Alt+Shift+E.
- Una única posición compartida en todas las anchuras.
El botón sigue ocultándose al abrir el panel. No se modifica ninguna función
de recopilación, formatos, multimedia, compresión, selección ni portapapeles.

ACTUALIZAR
El canal de auto-update permanece en:
https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js
Actualiza con tu gestor de userscripts y recarga WhatsApp Web.
Comprueba v1.5.2 en la cabecera. Alternativa: sustituye todo el código por el
TXT de esta versión o importa WhatsApp-Range-Exporter.user.js desde el ZIP.

VERIFICACIÓN
26 pruebas Node.js superadas (npm test) y sintaxis válida (npm run check).
Una prueba reconstruye exactamente la versión anterior para verificar que
solo han cambiado la versión y la regla CSS del botón.
Pruebas de navegador con Playwright y Camoufox, en una página local simulada:
1440x1080, 1440x768, 704x700, 390x844, 320x640 y 720x480.
Se reprodujo el solapamiento anterior con burbujas ficticias y se comprobó
su ausencia con el nuevo botón en los seis escenarios. Incluye controles
nativos de 48 y 64 px, contador, barra de escritura, redimensionado, apertura,
cierre, atajo de teclado y clics tanto en WhatsApp simulado como en mensajes.
El caso de 704x700 usa una densidad de píxeles de 1.25. No equivale a probar
el zoom nativo del navegador. Las capturas se revisaron en escritorio y móvil.
Entorno: Camoufox headless con Playwright y una página sintética interceptada
localmente. Sin errores de consola ni excepciones de página en la ejecución
final. No se accede a WhatsApp real durante estas pruebas.

LÍMITES
La posición es fija; no hay detección dinámica del diseño de WhatsApp.
Las pruebas usan datos sintéticos, no la sesión real del usuario. No se han
vuelto a probar las descargas multimedia ni el portapapeles nativo, ya que su
código no cambia. No se publica ninguna captura ni conversación del usuario.
