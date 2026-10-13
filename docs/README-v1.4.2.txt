WHATSAPP RANGE EXPORTER 1.4.2
Corrección de imágenes agrupadas y del estado de la cola

ACTUALIZAR
Abre WhatsApp-Range-Exporter-v1.4.2.txt y copia todo su contenido en el userscript
actual de Tampermonkey/Violentmonkey, sustituyendo el código anterior. Guarda,
recarga WhatsApp Web y vuelve a recopilar el rango. A continuación pulsa
Copiar imágenes. La cola anterior se debe preparar de nuevo.
El ZIP también contiene WhatsApp-Range-Exporter.user.js para instalarlo.

QUÉ SE HA CORREGIDO
- Dos miniaturas distintas bajo un mismo mensaje ya no se reducen a una por
  compartir el identificador de la burbuja. Cada archivo tiene identidad propia
  o, si falta su id nativo, una posición independiente dentro del grupo.
- El id nativo de la primera foto no se copia a las demás fotos del grupo.
- Se respetan los ids individuales presentes en las miniaturas y los extremos
  de los álbumes. Una miniatura y su capa de previsualización no se cuentan dos
  veces. Las imágenes citadas no se añaden como adjuntos nuevos.
- Los huecos de un álbum sin original disponible permanecen contados; no se
  eliminan como duplicados. Dos mensajes que usan la misma URL no se fusionan.
- Al reciclar WhatsApp una burbuja, las fuentes observadas de nuevo actualizan
  la misma foto, en lugar de añadir una foto fantasma. Se retienen alternativas
  de la misma imagen sin mezclar fuentes de archivos distintos.
- Una lista nativa repetida no provoca que se descarte otro miembro del álbum.
- No se incorporan fotos externas solo por estar cerca en fecha. Para completar
  un grupo se exigen ids o correspondencia suficiente de sus miembros.

CONTADOR Y AVISOS
Con dos imágenes recuperadas: 0/2, 1/2, 2/2. El segundo botón sigue disponible
tras copiar la primera, y cada una se copia como un PNG separado.
Si solo se puede recuperar una: el total sigue siendo 2, se muestra
“1/2 copiadas · 1 no disponible” y el botón termina en
“Copiadas las disponibles”, no “Todas copiadas”. El aviso de cola incompleta
permanece visible al copiar y los detalles de los fallos se abren al preparar.

SE MANTIENE
Copiar imágenes usa exclusivamente el portapapeles, con un clic por imagen.
No descarga ficheros ni crea ZIP. Pega la imagen en destino antes de copiar la
siguiente. Volver a copiar no avanza la cola; Cerrar cola no borra el portapapeles.
Se mantienen los botones del panel, Hasta = Último mensaje disponible,
las exclusiones, TXT sin cabecera, las correcciones de fechas/autores y el
arreglo de finalización de conversaciones cortas de la versión 1.4.1.
Los otros botones mantienen sus opciones de exportación y compresión.
No se añaden dependencias ni se cambia la versión fijada de WA-JS o JSZip.

ALCANCE Y LÍMITES
El script solicita los originales mediante WA-JS por identificador. Si esto
falla y existe una fuente visible válida, utiliza esa fuente con un aviso de
posible menor calidad. No convierte una previsualización de un PDF en su
supuesto documento original. No puede reconstruir un archivo ausente ni
garantizar que WhatsApp permita recuperar todas las imágenes.
La captura actual muestra dos fotos y una sola imagen preparada, pero no
permite determinar por sí sola si el segundo original falló o se descartó.
Se reprodujeron errores de identidad compatibles con ese síntoma, además del
estado engañoso de finalización. No se ha accedido a la sesión real del usuario.

VERIFICACIÓN DE ESTA ENTREGA
26 pruebas de lógica en Node.js, 11 comprobaciones de extracción/cola en
Chromium y 16 comprobaciones de interacción de panel: 53 comprobaciones
superadas. Sintaxis JavaScript y CRC del ZIP comprobados; TXT idéntico al script.

Las pruebas de DOM incluyen burbujas con dos fotos, álbumes clásicos, álbumes
anidados, capas de previsualización, citas y una muestra HTML anterior aportada
por el usuario con un álbum de 12 fotos. Esa muestra no es el DOM de la captura
actual del taller. Las imágenes de prueba son PNG distintos generados localmente.

Entorno: Node.js 22.16.0; Chromium 144.0.7559.96; Playwright local sobre
about:blank. Pantallas 1440x1080 y 390x844 sin desbordamiento horizontal del panel.
La carga/decodificación de PNG es real. WA-JS y la API del portapapeles se simulan.
Se comprueba que las dos copias contienen PNG diferentes y que la ruta de copiar
imágenes genera cero descargas. Se prueban exclusiones, reintentos de copia,
original no disponible y conservación del contador total tras un fallo.

La navegación a localhost para una prueba del portapapeles nativo fue bloqueada
por el entorno con ERR_BLOCKED_BY_ADMINISTRATOR. Se continuó con una página en
memoria y API simulada, sin eludir el bloqueo. No se ha validado el portapapeles
nativo ni el pegado en ChatGPT Desktop/Codex. No se ha vuelto a probar el motor
ZIP de exportaciones multimedia; se conserva el motor anterior y sí se verifica
el ZIP de distribución de esta entrega.

REFERENCIA DE LA API DE ORIGINALES
https://wppconnect.io/wa-js/functions/chat.downloadMedia.html
