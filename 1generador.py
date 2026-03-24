import os
import sys
import re
import anthropic
from pypdf import PdfReader
import html2docx


def leer_token(ruta_archivo="token.txt"):
    if not os.path.exists(ruta_archivo):
        return None
    with open(ruta_archivo, 'r', encoding='utf-8') as f:
        return f.read().strip()


def listar_archivos(extensiones=('.txt', '.pdf')):
    return [f for f in os.listdir('.') if f.lower().endswith(extensiones) and os.path.isfile(f) and f != "token.txt"]


def seleccionar_archivo(tipo_archivo, archivos_disponibles):
    print(f"\n--- Selecciona el archivo para: {tipo_archivo} ---")
    for i, archivo in enumerate(archivos_disponibles):
        print(f"[{i}] {archivo}")
    
    while True:
        try:
            seleccion = int(input(f"Ingresa el número para {tipo_archivo}: "))
            if 0 <= seleccion < len(archivos_disponibles):
                return archivos_disponibles[seleccion]
            print("Error: Número fuera de rango.")
        except ValueError:
            print("Error: Debes ingresar un número entero.")


def obtener_oferta_laboral(archivos_disponibles):
    print("\n--- Oferta Laboral (Job Description) ---")
    print("[1] Seleccionar un archivo existente de la lista")
    print("[2] Pegar el texto directamente en la consola")
    
    while True:
        opcion = input("Ingresa 1 o 2: ")
        if opcion == '1':
            archivo = seleccionar_archivo("Oferta Laboral", archivos_disponibles)
            return extraer_texto(archivo)
        elif opcion == '2':
            print("\nPega el texto de la oferta laboral abajo.")
            print("IMPORTANTE: Cuando termines, escribe la palabra FIN en una línea nueva y presiona Enter.")
            lineas = []
            while True:
                linea = input()
                if linea.strip().upper() == 'FIN':
                    break
                lineas.append(linea)
            return "\n".join(lineas).strip()
        else:
            print("Error: Ingresa 1 o 2.")


def extraer_texto(ruta_archivo):
    texto = ""
    if ruta_archivo.lower().endswith('.pdf'):
        try:
            reader = PdfReader(ruta_archivo)
            for page in reader.pages:
                texto += page.extract_text() + "\n"
        except Exception as e:
            print(f"Error leyendo el PDF {ruta_archivo}: {e}")
    else:
        with open(ruta_archivo, 'r', encoding='utf-8') as f:
            texto = f.read()
    return texto


def limpiar_markdown(texto):
    texto = texto.strip()
    if texto.startswith("```html"):
        texto = texto[7:]
    elif texto.startswith("```"):
        texto = texto[3:]
    if texto.endswith("```"):
        texto = texto[:-3]
    return texto.strip()


def html_a_docx(html_content, nombre_base):
    try:
        buffer = html2docx.html2docx(html_content, title="CV Optimizado")
        nombre_docx = f"CV_Editable_{nombre_base}.docx"
        with open(nombre_docx, "wb") as f:
            f.write(buffer.getvalue())
        return nombre_docx
    except Exception as e:
        print(f"Error convirtiendo HTML a DOCX: {e}")
        return None


def principal():
    api_key = leer_token()
    if not api_key:
        print("Fallo de ejecución: No se encontró el archivo 'token.txt' o está vacío. Crea el archivo en esta carpeta y pega tu API Key ahí.")
        return

    client = anthropic.Anthropic(api_key=api_key)

    ruta_prompt = "producto_v2.txt"
    if not os.path.exists(ruta_prompt):
        print(f"Fallo de ejecución: No se encuentra '{ruta_prompt}'.")
        return
    
    prompt_sistema = extraer_texto(ruta_prompt)

    archivos_validos = listar_archivos()
    if len(archivos_validos) < 1:
        print("No hay archivos .txt o .pdf en la carpeta actual para procesar (excluyendo token.txt).")
        return

    archivo_cv = seleccionar_archivo("CV del candidato", archivos_validos)
    oferta_texto = obtener_oferta_laboral(archivos_validos)
    
    mercado_objetivo = input("\nIngresa el mercado objetivo (ej: Argentina, España, LATAM, Estados Unidos): ").strip()

    print(f"\nExtrayendo texto del CV...")
    cv_texto = extraer_texto(archivo_cv)

    prompt_usuario = (
        f"<cv_original>\n{cv_texto}\n</cv_original>\n\n"
        f"<oferta_laboral>\n{oferta_texto}\n</oferta_laboral>\n\n"
        f"<mercado_objetivo>\n{mercado_objetivo}\n</mercado_objetivo>"
    )

    print("Procesando con Claude Haiku...")
    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=12000,
            temperature=0.0,
            system=prompt_sistema,
            messages=[{"role": "user", "content": prompt_usuario}]
        )
        
        respuesta = response.content[0].text
        
        if "###CV_HTML###" in respuesta and "###INFORME_HTML###" in respuesta:
            partes = respuesta.split("###INFORME_HTML###")
            cv_raw = partes[0].replace("###CV_HTML###", "").strip()
            informe_raw = partes[1].strip()
            
            cv_html = limpiar_markdown(cv_raw)
            informe_html = limpiar_markdown(informe_raw)
            
            nombre_base = os.path.splitext(archivo_cv)[0]
            archivo_cv_salida = f"CV_Visual_{nombre_base}.html"
            archivo_informe_salida = f"Informe_{nombre_base}.html"
            
            with open(archivo_cv_salida, "w", encoding="utf-8") as f:
                f.write(cv_html)
                
            with open(archivo_informe_salida, "w", encoding="utf-8") as f:
                f.write(informe_html)
            
            print("Generando DOCX editable...")
            archivo_docx = html_a_docx(cv_html, nombre_base)
                
            print(f"\nProceso completado. Se generaron tres archivos:")
            print(f"- {archivo_cv_salida}")
            print(f"- {archivo_informe_salida}")
            if archivo_docx:
                print(f"- {archivo_docx}")
        else:
            print("Fallo en la estructura de la respuesta. Claude no respetó los delimitadores ###CV_HTML### y ###INFORME_HTML###.")
            print("Output crudo para depurar:")
            print(respuesta)
            
    except Exception as e:
        print(f"Error de API: {e}")


if __name__ == "__main__":
    principal()