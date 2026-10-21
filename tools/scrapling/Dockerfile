FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN pip install --no-cache-dir -r requirements.txt && scrapling install
COPY servidor.py .
RUN useradd --create-home extractor
RUN chmod -R a+rX /opt/browsers
USER extractor
EXPOSE 8000
CMD ["python", "servidor.py"]
