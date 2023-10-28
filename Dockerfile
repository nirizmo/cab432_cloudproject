# Use an official Node.js runtime as the base image
FROM node:14

# Set the working directory in the container
WORKDIR /app

# Copy your Node.js application files into the container
COPY package*.json ./
RUN npm install
COPY . .

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Expose the port your application will run on
EXPOSE 3000

# Command to run your application
CMD ["npm", "start"]
