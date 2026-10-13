# WhatsApp Range Exporter

Userscript para **WhatsApp Web**: copiar y exportar rangos de mensajes y sus adjuntos, excluir mensajes concretos y copiar imágenes por separado mediante una cola manual de portapapeles.

**Versión: 1.4.2.** El código de esta publicación es idéntico al archivo v1.4.2 entregado originalmente. No se ha cambiado el funcionamiento ni añadido actualización automática.

## Instalación y actualización

[Descargas de v1.4.2](https://github.com/alexx-ftw/whatsapp-range-exporter/releases/tag/v1.4.2)

1. Descarga el ZIP de la versión y extrae `WhatsApp-Range-Exporter.user.js`, o utiliza la copia `.txt`.
2. En Tampermonkey o Violentmonkey, abre el userscript existente y sustituye todo su contenido por el código de esta versión. Para una instalación nueva, crea un userscript y pega el código.
3. Guarda y recarga WhatsApp Web.
4. Abre el panel mediante el botón de exportación o `Alt + Shift + E`.

El repositorio es privado: necesitas iniciar sesión en una cuenta con acceso para ver sus archivos y descargas. El ZIP y el TXT permiten instalar sin depender de enlaces de descarga de ChatGPT.

## Uso

Elige **Desde** y **Hasta** mediante un mensaje seleccionado, una fecha y hora o el primer/último mensaje disponible. `Hasta` usa **Último mensaje disponible** por defecto. Pulsa **Recopilar rango** y después **Copiar** o **Descargar**.

La interfaz utiliza botones visibles en lugar de desplegables. Permite TXT, CSV, JSON y HTML, y exportar sin adjuntos, con archivos separados, en ZIP o en ZIP con compresión DEFLATE nivel 9. El TXT empieza directamente por los mensajes, sin la cabecera de chat, recuento y fecha de exportación.

### Excluir mensajes

Pulsa **Seleccionar mensajes** en la sección de exclusiones y marca las burbujas que quieras omitir. Otro clic las vuelve a incluir. Finaliza con el botón correspondiente o `Esc`. Se excluyen tanto el mensaje como sus adjuntos; seleccionar un álbum excluye sus fotos. No se elimina nada de WhatsApp.

### Copiar imágenes por separado

1. Recopila el rango y pulsa **Copiar imágenes**.
2. Pulsa **Copiar 1 de N** y pega la imagen en la aplicación de destino.
3. Vuelve al panel y pulsa **Copiar siguiente**. Pega cada imagen antes de copiar la siguiente.

Este botón usa solo el portapapeles: no une imágenes, no guarda archivos y no crea ZIP. Las imágenes se convierten a PNG individuales. **Volver a copiar** repite la última sin avanzar. El script no puede detectar que se haya pegado una imagen en otra aplicación.

## Cambios en 1.4.2

- Identidad independiente para fotos agrupadas bajo una misma burbuja o álbum, sin descartar la segunda como duplicada.
- No se reutiliza el identificador nativo de la primera foto para las demás.
- Se distinguen fotos, capas de previsualización y contenido citado.
- El contador mantiene los archivos no disponibles: por ejemplo, **1/2 copiadas · 1 no disponible**, en lugar de presentar la cola como completa.
- Se conservan las correcciones anteriores de fechas, autores y finalización de conversaciones cortas.

[Notas completas de la entrega y alcance de las pruebas](docs/README-v1.4.2.txt)

## Dependencias y límites

El encabezado del userscript fija WA-JS **4.6.0** y JSZip **3.10.1**. El script solicita los originales a la sesión abierta de WhatsApp mediante WA-JS. Si no están disponibles y existe una fuente visible válida, puede utilizarla con un aviso de posible menor calidad. No convierte una miniatura de PDF en un supuesto documento original.

No se garantiza recuperar medios que WhatsApp ya no exponga. La integración depende de la estructura e interfaces internas de WhatsApp y puede requerir ajustes cuando cambien. La compresión adicional de archivos ya comprimidos puede ser pequeña.

La entrega 1.4.2 se comprobó con pruebas locales; no se validó el pegado nativo en ChatGPT Desktop/Codex ni la sesión real de WhatsApp. Los detalles y limitaciones de esa comprobación están en las notas de la entrega. Publicar este repositorio no constituye una nueva prueba de esos flujos.

## Privacidad

Este repositorio contiene únicamente el código, sus instrucciones y sumas de comprobación. No incluye conversaciones exportadas, adjuntos de chats, capturas privadas ni muestras reales de DOM. Los archivos se procesan en el navegador y los originales se solicitan a la sesión de WhatsApp; los recursos de las dependencias se cargan desde las direcciones indicadas en el encabezado del userscript.

## Integridad

`SHA256SUMS.txt` contiene las sumas de los archivos del repositorio. Los paquetes de la versión incluyen sus propias sumas de comprobación. La copia `.txt` y el archivo `.user.js` contienen exactamente el mismo código.
