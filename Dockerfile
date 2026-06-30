FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

RUN mkdir -p /var/lib/ojt-data && chmod 755 /var/lib/ojt-data

ENV PORT=5000

EXPOSE 5000

# Run initialization before starting gunicorn
CMD python -c "from app import initialize_app; initialize_app()" && exec gunicorn --workers 2 --bind "0.0.0.0:${PORT}" app:app