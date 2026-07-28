import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from app.main import app


@pytest_asyncio.fixture(autouse=True)
async def _db(setup_database):
    yield


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_list_libraries(client):
    response = await client.get("/api/color-libraries")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)


@pytest.mark.asyncio
async def test_get_default_library(client):
    response = await client.get("/api/color-libraries/1")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == 1
    assert "entries" in data
    assert isinstance(data["entries"], list)


@pytest.mark.asyncio
async def test_add_entry(client):
    data = {"code": "TST001", "color_hex": "#AABBCC", "color_name": "Test Color", "sort_order": 0}
    response = await client.post("/api/color-libraries/1/entries", json=data)
    assert response.status_code == 201
    entry = response.json()
    assert entry["code"] == "TST001"
    assert entry["color_hex"] == "#AABBCC"
    assert entry["color_name"] == "Test Color"
    assert entry["sort_order"] == 0
    await client.delete(f"/api/color-libraries/1/entries/{entry['id']}")


@pytest.mark.asyncio
async def test_update_entry(client):
    create_data = {"code": "TST002", "color_hex": "#AABBCC"}
    create_resp = await client.post("/api/color-libraries/1/entries", json=create_data)
    assert create_resp.status_code == 201
    entry_id = create_resp.json()["id"]

    update_data = {"color_name": "Updated Name", "sort_order": 5}
    response = await client.put(f"/api/color-libraries/1/entries/{entry_id}", json=update_data)
    assert response.status_code == 200
    assert response.json()["color_name"] == "Updated Name"
    assert response.json()["sort_order"] == 5

    await client.delete(f"/api/color-libraries/1/entries/{entry_id}")


@pytest.mark.asyncio
async def test_delete_entry(client):
    create_data = {"code": "TST003", "color_hex": "#DDFFEE"}
    create_resp = await client.post("/api/color-libraries/1/entries", json=create_data)
    assert create_resp.status_code == 201
    entry_id = create_resp.json()["id"]

    response = await client.delete(f"/api/color-libraries/1/entries/{entry_id}")
    assert response.status_code == 204

    lib_resp = await client.get("/api/color-libraries/1")
    codes = [e["code"] for e in lib_resp.json()["entries"]]
    assert "TST003" not in codes


@pytest.mark.asyncio
async def test_duplicate_code_rejected(client):
    data = {"code": "TST004", "color_hex": "#112233"}
    response = await client.post("/api/color-libraries/1/entries", json=data)
    assert response.status_code == 201
    entry_id = response.json()["id"]

    response = await client.post("/api/color-libraries/1/entries", json=data)
    assert response.status_code == 409

    await client.delete(f"/api/color-libraries/1/entries/{entry_id}")


@pytest.mark.asyncio
async def test_get_nonexistent_library(client):
    response = await client.get("/api/color-libraries/99999")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_nonexistent_entry(client):
    response = await client.delete("/api/color-libraries/1/entries/99999")
    assert response.status_code == 404
