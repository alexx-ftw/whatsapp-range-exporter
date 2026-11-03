WHATSAPP RANGE EXPORTER v1.5.1
Botón de acceso separado de los controles de WhatsApp

CAMBIO
El botón del exportador se desplaza a la izquierda: su borde derecho queda a
96 píxeles CSS del borde de la ventana, más el área segura del dispositivo.
Se elimina la regla de pantallas estrechas que lo devolvía a la esquina.
Se mantiene su tamaño de 52 x 52 píxeles, altura, tema y atajo Alt+Shift+E.
No se añaden observadores, temporizadores, dependencias ni peticiones de red.
El panel y el motor de recopilación, fechas, adjuntos, compresión y portapapeles
no se modifican. No se mueve ni se altera ningún control nativo de WhatsApp.

ACTUALIZAR
El canal de auto-update sigue siendo el mismo:
https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js
Actualiza desde el gestor o sustituye el código por el TXT completo. Recarga
WhatsApp Web y comprueba que la cabecera indique v1.5.1.

VERIFICACIÓN
24 pruebas Node superadas con npm test, incluidas 4 de regresión nuevas.
Sintaxis comprobada con npm run check. La prueba de identidad del código
confirma que solo cambian las dos reglas de posición y los números de versión
respecto al userscript 1.5.0; el resto del código conserva exactamente sus bytes.
Se reprodujo la colisión anterior y se comprobó su ausencia después del cambio
en Camoufox (Firefox), con Playwright y una página sintética aislada, en cinco
ventanas: 1440x1080, 1440x768, 390x844, 320x640 y 720x480.
Se comprobaron clics en ambos botones, apertura y cierre del panel, versión
visible, atajo de teclado, cambio de ancho de ventana y un control nativo de
64 píxeles de ancho. No se detectaron errores de ejecución en esas pruebas.
Se revisaron capturas de escritorio y ventana estrecha antes y después.
La conexión Browser de esta sesión solo permitía lectura; se utilizó Camoufox
local en un perfil temporal independiente, sin tocar las pestañas del usuario.

LÍMITES
No se ha probado esta revisión dentro de una sesión real de WhatsApp ni un
ciclo de actualización dentro del gestor. El arreglo reserva espacio fijo en
la zona inferior derecha; no intenta detectar cualquier control flotante
futuro ni corregir cambios de distribución de WhatsApp ajenos a este caso.
La muestra del chat y la captura privada no forman parte de la publicación.
