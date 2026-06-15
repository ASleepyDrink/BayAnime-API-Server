# What Is BayAnime API Server?
BayAnime API Server is a dedicated API server so anyone can make a streaming service using local files to run across servers without having to write the logic for a local library.

This allows you to make custom clients for local library usage. It includes caching as well so it caches the appropriate media from the folders so its faster to serve the media links every time so you don't have to wait for the stream links.

# Can i use this to build my application?
YES! Please do! This is meant to help you the developer speed up the process of sending your local library outside of your pc to another and so on!

# Routes
| Type | Route | Description |
|------|-------|-------------|
| GET | /api/library | Get your local library with the streaming links returned in a JSON format. |
| POST | /api/sync | Sync your local library with the cache (Runs Automatically) |
