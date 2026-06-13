import os
from dotenv import load_dotenv

load_dotenv()

MAP_SERVICE_URL = os.getenv("VITE_MAP_SERVICE_URL")
