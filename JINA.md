cd "/Users/vincent.wuhrlin/Repositories/tcc/node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/@huggingface/transformers/.cache/jinaai/jina-embeddings-v3/onnx/"


cd "node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/@huggingface/transformers/.cache/jinaai/jina-embeddings-v3/onnx/"
ls
  model_fp16.onnx

curl -k -L "https://huggingface.co/jinaai/jina-embeddings-v3/resolve/main/onnx/model.onnx_data" -o model.onnx_data
ls
  model_fp16.onnx
  model.onnx_data

