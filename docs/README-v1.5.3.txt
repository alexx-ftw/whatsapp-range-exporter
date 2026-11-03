WHATSAPP RANGE EXPORTER v1.5.3
Botón discreto hasta pasar el ratón

CAMBIO
El botón del exportador queda al 14 % de opacidad y sin sombra en reposo.
Al pasar el ratón, enfocarlo con el teclado o pulsarlo, alcanza el 100 %.
Al apartar el ratón vuelve a atenuarse, salvo que conserve foco de teclado.
La transición de opacidad dura 140 ms; se desactiva con movimiento reducido.
No se anima el tamaño ni la posición ni el cambio de color del tema.
En dispositivos que indican hover:none, la opacidad en reposo es del 50 %
para que el control siga siendo localizable sin ratón.

SE MANTIENE
Posición de v1.5.2: margen derecho, encima del control nativo de WhatsApp.
Área del botón de 44 x 44 píxeles, atajo Alt+Shift+E, temas y todas las
funciones del exportador. No se añaden librerías, permisos ni temporizadores.
Los cambios del userscript se limitan al CSS del botón y al número de versión.

ACTUALIZAR
El canal de auto-update mantiene la misma dirección estable:
https://github.com/alexx-ftw/whatsapp-range-exporter/raw/refs/heads/main/WhatsApp-Range-Exporter.user.js
Actualiza en el gestor de userscripts y recarga WhatsApp Web.
La cabecera debe mostrar v1.5.3. También se distribuyen ZIP y TXT idéntico.

VERIFICACIÓN
31 pruebas Node.js con npm test, y sintaxis con npm run check.
Las nuevas pruebas de opacidad fallaron sobre v1.5.2 y pasan sobre v1.5.3.
Cinco escenarios Camoufox/Firefox mediante Playwright en una página local
interceptada (https://wa-exporter-test.invalid/), sin tráfico a WhatsApp.
Tamaños: 1440x900, 1440x768, 390x844 y 320x640; temas claro/oscuro.
Un escenario adicional en 390x844 usa emulación táctil y hover:none real.
Se comprobaron opacidad calculada, hover, salida del puntero, Tab, foco visible,
pulsación, apertura/cierre del panel, versión, atajo, movimiento reducido,
tamaño y posición constantes y clic en el control nativo simulado.
No se detectaron errores de página/consola ni colisiones en esos escenarios.
Las capturas de reposo y hover se revisaron visualmente.
Se usó Camoufox siguiendo la preferencia de navegador del usuario.

LÍMITES
Pruebas con mensajes ficticios, no en una sesión real de WhatsApp.
La emulación táctil no sustituye una prueba en un dispositivo físico.
No se ha probado la actualización automática dentro del gestor del usuario.
No se publican conversaciones, imágenes privadas ni muestras reales de DOM.
