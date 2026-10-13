WHATSAPP RANGE EXPORTER v1.5.0
Interfaz renovada y versión instalada visible

INSTALACIÓN Y AUTO-UPDATE
El canal estable sigue siendo:
https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js
Instala/actualiza desde ese enlace, o copia el TXT completo en tu userscript.
Recarga WhatsApp Web después de que el gestor instale la revisión.
La cabecera debe mostrar v1.5.0: es la versión ejecutada en esa pestaña, no una
consulta de la versión remota. Se conservan @name, @namespace, @updateURL,
@downloadURL, permisos y dependencias. No se añaden librerías.

INTERFAZ
- Cabecera fija con versión instalada y botón de cerrar. El lanzador también
  incluye la versión y el atajo Alt+Shift+E en su descripción.
- Cuerpo desplazable independiente: acciones, estado y cancelar quedan fuera
  del scroll. Cerrar el panel no cancela una operación.
- Resumen Desde/Hasta y nombre del chat. Rango y salida separados visualmente.
- Excluir/reincluir conserva los datos y no borra mensajes de WhatsApp.
- Formato, fechas, adjuntos y tema se eligen con botones visibles, sin menús.
- Tema Sistema/Claro/Oscuro guardado junto con las preferencias existentes.
- Contadores de mensajes, archivos recuperados y no disponibles. Un guion
  significa que aún no se han preparado los adjuntos, no que hayan fallado.
- La cola de imágenes informa de su propio subconjunto, no de todos los PDFs,
  audios y vídeos del chat. Tiene prioridad en el resumen mientras está abierta.
- Avisos persistentes de resultado parcial y originales no disponibles. El
  progreso porcentual solo se usa cuando existe total conocido; el recorrido
  del chat no inventa un porcentaje.
- Vista previa de imágenes más grande y cola al principio del contenido.
  Al prepararla, se desplaza a la cola. Cada copia sigue requiriendo un clic.
- Cerrar con Esc dentro del panel, foco visible, radios con flechas y ayuda
  cuando las acciones aún no están disponibles. El selector de mensajes tiene
  un botón explícito para volver al panel.

SE MANTIENE
Hasta = Último mensaje disponible, TXT sin cabecera, límites incluidos,
exclusiones, detección de fechas/autores, álbumes y parada de chats cortos.
Copiar imágenes utiliza solo el portapapeles: no une fotos ni descarga ZIP.
El botón general Copiar puede descargar adjuntos en ZIP si el portapapeles no
admite su copia; ahora la interfaz lo advierte al seleccionar adjuntos.
No se ha cambiado el motor de recopilación, formatos, compresión, descargas ni
portapapeles. Sus funciones previas conservan el código de v1.4.3.

VERIFICACIÓN
20 pruebas Node.js (npm test), más sintaxis (npm run check).
63 comprobaciones en Chromium mediante Playwright: controles, estados,
selección, cancelación, fecha/hora, reinclusión, cambio de chat, temas,
persistencia de preferencias, aviso de archivos fallidos y cola de dos fotos.
Tamaños: 1440x1080, 1440x768, 390x844, 320x640 y 720x480.
Se revisaron capturas claras y oscuras; no hubo desbordamiento horizontal del
panel ni botones principales fuera de la ventana en esos tamaños.
Se corrigió un destello de botones claros al cambiar al tema oscuro y se
comprobó que las actualizaciones de tema del sistema esperan su evento real.

ENTORNO Y LÍMITES DE LAS PRUEBAS
Interfaz renderizada en about:blank con datos sintéticos. La navegación a una
URL de prueba fue bloqueada por el entorno (ERR_BLOCKED_BY_ADMINISTRATOR);
no se eludió ese bloqueo. No había Browser plugin; se utilizó Playwright local.
Se simularon WA-JS, almacenamiento y portapapeles; la decodificación PNG fue
real. Se comprobó que Copiar imágenes no provoca descargas y no pierde la
posición al denegarse el portapapeles. No se ha verificado la sesión real de
WhatsApp, el portapapeles del sistema, el pegado en ChatGPT Desktop/Codex ni un
ciclo de actualización dentro del gestor de userscripts.
Las pruebas Node incluyen una huella del motor previo para detectar cambios
accidentales, además de los tests de datos de presentación y de cola.
No se han publicado conversaciones, muestras reales del DOM ni fotos privadas.
